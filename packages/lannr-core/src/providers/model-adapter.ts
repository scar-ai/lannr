import { encode as encodeO200k } from 'gpt-tokenizer'
import { partsToPlainText } from './image-input.js'
import { readOpenAICodexAccessToken } from './openai-codex-auth.js'
import { parseRateLimitHeaders } from './rate-limits.js'
import { rateBus } from './rate-bus.js'
import { resolvePromptCacheKey } from '../core/index.js'

interface ModelRequestError extends Error {
  status?: number
  headers?: Record<string, string>
  body?: string
  providerId?: string
  providerType?: string
}

// ── HTTP wrapper: capture rate-limit headers on every response (success AND
// error) so the gateway can surface bucket state to the UI and feed a smarter
// 429 backoff than a static 10-second guess. Errors are thrown with `status`
// and `headers` attached so classifyError() can read them.
async function fetchModel(url, init, { providerId, providerType }) {
  const res = await fetch(url, init)
  publishRateState(res.headers, providerId, providerType)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err = new Error(`Model request failed: ${res.status} ${body}`) as ModelRequestError
    err.status = res.status
    err.headers = headersToPlain(res.headers)
    err.body = body
    err.providerId = providerId
    err.providerType = providerType
    throw err
  }
  return res
}

function publishRateState(headers, providerId, providerType) {
  if (!providerId) return
  try {
    const state = parseRateLimitHeaders(headers, providerType)
    if (state) rateBus.publish(providerId, state)
  } catch {
    // Header parsing is best-effort — never fail a request over it.
  }
}

function headersToPlain(headers) {
  if (!headers || typeof headers.forEach !== 'function') return {}
  const out = {}
  headers.forEach((value, key) => { out[key.toLowerCase()] = value })
  return out
}

// ── Multipart content helpers ────────────────────────────────────────────────
//
// Internal message content is either a string (plain text) or an array of
// `{type:'text'|'image', ...}` parts (when the user attached image(s)). Each
// provider has its own wire format for image inputs, so we translate here.

function toolContentText(message) {
  return `Lannr execution result:\n${partsToPlainText(message.content)}`
}

function toOpenAIChatContent(message) {
  if (message.role === 'tool') return toolContentText(message)
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')
  return content.map((part) => {
    if (typeof part === 'string') return { type: 'text', text: part }
    if (part?.type === 'image') {
      return { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } }
    }
    return { type: 'text', text: part?.text ?? '' }
  })
}

function toAnthropicContent(message) {
  if (message.role === 'tool') return toolContentText(message)
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')
  return content.map((part) => {
    if (typeof part === 'string') return { type: 'text', text: part }
    if (part?.type === 'image') {
      return { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } }
    }
    return { type: 'text', text: part?.text ?? '' }
  })
}

function toGoogleParts(message) {
  if (message.role === 'tool') return [{ text: toolContentText(message) }]
  const content = message.content
  if (typeof content === 'string') return [{ text: content }]
  if (!Array.isArray(content)) return [{ text: String(content ?? '') }]
  return content.map((part) => {
    if (typeof part === 'string') return { text: part }
    if (part?.type === 'image') return { inlineData: { mimeType: part.mediaType, data: part.data } }
    return { text: part?.text ?? '' }
  })
}

function toOpenAIResponsesContent(message) {
  const textType = message.role === 'assistant' ? 'output_text' : 'input_text'
  if (message.role === 'tool') {
    return [{ type: 'input_text', text: toolContentText(message) }]
  }
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')
  return content.map((part) => {
    if (typeof part === 'string') return { type: textType, text: part }
    if (part?.type === 'image') {
      return { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}` }
    }
    return { type: textType, text: part?.text ?? '' }
  })
}

export function createModelAdapter(provider, model) {
  const runtime = { ...provider, model: model ?? provider.defaultModel }
  const type = String(runtime.type ?? '').toLowerCase()
  if (isCodexProvider(runtime)) return codexOAuthAdapter(runtime)
  if (['anthropic', 'anthropic-messages', 'anthropic-compatible'].includes(type)) return anthropicAdapter(runtime)
  if (['google', 'gemini', 'google-gemini'].includes(type)) return googleAdapter(runtime)
  if (['bedrock', 'google-vertex', 'openclaw-plugin'].includes(type)) {
    throw new Error(runtime.unsupportedReason ?? `${runtime.id ?? type} requires OpenClaw plugin runtime support and is not available in lannr-cli local mode.`)
  }
  if (!runtime.baseURL) {
    throw new Error(`Provider "${runtime.id ?? 'unknown'}" needs a baseURL before lannr-cli can use it.`)
  }
  return openaiChatAdapter({
    providerId: runtime.id,
    providerType: runtime.type,
    model: runtime.model,
    baseURL: runtime.baseURL,
    apiKey: runtime.apiKey,
    endpoint: runtime.endpoint,
    promptCacheKey: runtime.promptCacheKey,
  })
}

function isCodexProvider(provider) {
  return provider.id === 'openai-codex' || provider.endpoint === 'codex-responses'
}

// ── Token counting ─────────────────────────────────────────────────────────────
//
// Returns the *real* prompt token count for `messages` as the active provider
// would tokenize them — not a chars/4 estimate. Works for ALL providers:
//   - Anthropic: POST /v1/messages/count_tokens   (free, exact, no generation)
//   - Google:    POST /models/<m>:countTokens     (free, exact, no generation)
//   - OpenAI / codex / OpenAI-compatible / unknown: the o200k_base tokenizer
//     (what GPT-4o/4.1/5 and codex actually use) — exact, offline, instant.
// Resolves to { tokens, exact, source }. `exact` is false only when we fall
// back to o200k for a non-OpenAI provider whose own counter was unavailable.
export async function countTokens(provider, model, messages, opts = {}) {
  const type = String(provider?.type ?? '').toLowerCase()
  const isCodex = provider?.id === 'openai-codex' || provider?.endpoint === 'codex-responses'
  const isAnthropic = !isCodex && ['anthropic', 'anthropic-messages', 'anthropic-compatible'].includes(type)
  const isGoogle = ['google', 'gemini', 'google-gemini'].includes(type)

  if (isAnthropic || isGoogle) {
    try {
      const adapter = createModelAdapter(provider, model)
      if (typeof (adapter as any).countTokens === 'function') {
        return await (adapter as any).countTokens(messages, opts)
      }
    } catch {
      // Endpoint unavailable (no key, compat server without /count_tokens, …) —
      // fall through to the local tokenizer as a best-effort approximation.
    }
    return { tokens: localChatTokenCount(messages, opts), exact: false, source: 'o200k_base (approx; native counter unavailable)' }
  }

  // OpenAI / codex / OpenAI-compatible / unknown → o200k_base is exact.
  return { tokens: localChatTokenCount(messages, opts), exact: true, source: 'o200k_base tokenizer' }
}

// True when the provider counts tokens via a free dedicated endpoint (no
// generation). Kept for callers that want to gate per-slice network counting.
export function supportsFreeTokenCount(provider) {
  if (!provider) return false
  if (provider.id === 'openai-codex' || provider.endpoint === 'codex-responses') return false
  const type = String(provider.type ?? '').toLowerCase()
  return ['anthropic', 'anthropic-messages', 'anthropic-compatible', 'google', 'gemini', 'google-gemini'].includes(type)
}

// Plain text of a message's content (string or {type:'text'} parts); images and
// other non-text parts contribute no text tokens here.
function messageContentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text ?? '' : '')).join('')
  }
  return String(content ?? '')
}

// Local token count using o200k_base plus OpenAI's ChatML framing overhead
// (~3 tokens per message + 3 priming tokens), matching the cookbook formula.
function localChatTokenCount(messages, opts: Record<string, any> = {}) {
  const all = opts?.system ? [{ role: 'system', content: opts.system }, ...(messages ?? [])] : (messages ?? [])
  let tokens = 0
  for (const message of all) {
    tokens += 3
    tokens += encodeO200k(`${message?.role ?? 'user'}\n${messageContentText(message?.content)}`).length
  }
  return tokens + 3
}

function codexOAuthAdapter(provider) {
  return {
    async complete(messages, opts) {
      const adapter = await codexHttpAdapter(provider)
      return adapter.complete(messages, opts)
    },
    async *stream(messages, opts) {
      const adapter = await codexHttpAdapter(provider)
      yield* adapter.stream(messages, opts)
    },
  }
}

async function codexHttpAdapter(provider) {
  const apiKey = provider.apiKey ?? await readCodexAccessToken()
  return codexResponsesAdapter({
    providerId: provider.id,
    providerType: provider.type ?? 'openai',
    model: provider.model,
    baseURL: provider.baseURL,
    apiKey,
    promptCacheKey: provider.promptCacheKey,
  })
}

function codexResponsesAdapter({ providerId, providerType, model, baseURL, apiKey, promptCacheKey }) {
  const url = `${trimRight(canonicalCodexBaseURL(baseURL))}/responses`
  const ctx = { providerId, providerType }
  return {
    async complete(messages, opts) {
      const res = await fetchModel(url, {
        method: 'POST',
        headers: codexHeaders(apiKey),
        body: JSON.stringify(codexRequestBody({ model, messages, system: opts?.system, promptCacheKey: resolvePromptCacheKey(opts?.promptCacheKey, promptCacheKey) })),
      }, ctx)
      let text = ''
      for await (const chunk of parseCodexResponsesStream(res)) text += chunk.text ?? ''
      return text
    },
    async *stream(messages, opts) {
      const res = await fetchModel(url, {
        method: 'POST',
        headers: codexHeaders(apiKey),
        body: JSON.stringify(codexRequestBody({ model, messages, system: opts?.system, promptCacheKey: resolvePromptCacheKey(opts?.promptCacheKey, promptCacheKey) })),
      }, ctx)
      yield* parseCodexResponsesStream(res)
    },
  }
}

function canonicalCodexBaseURL(baseURL) {
  const trimmed = trimRight(baseURL)
  if (!trimmed) throw new Error('OpenAI Codex provider requires a baseURL.')
  if (/^https?:\/\/chatgpt\.com\/backend-api$/i.test(trimmed)) return `${trimmed}/codex`
  return trimmed
}

function codexHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
}

function codexRequestBody({ model, messages, system = '', promptCacheKey }) {
  const instructions = [
    system,
    ...messages.filter((message) => message.role === 'system').map((message) => partsToPlainText(message.content)),
  ].filter(Boolean).join('\n\n') || 'You are a helpful coding assistant.'
  return {
    model,
    instructions,
    store: false,
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    input: messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: toOpenAIResponsesContent(message),
      })),
    stream: true,
  }
}

async function* parseCodexResponsesStream(res) {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawDelta = false
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue
      const json = JSON.parse(data)
      const { text, delta, usage } = codexStreamChunk(json, { sawDelta })
      if (delta) sawDelta = true
      if (text) yield { text }
      if (usage) yield { usage }
    }
  }
}

function codexStreamChunk(json, { sawDelta }) {
  if (json.type === 'response.output_text.delta') return { text: json.delta ?? '', delta: true }
  if (typeof json.delta === 'string') return { text: json.delta, delta: true }
  if (json.type === 'response.output_text.done') return { text: sawDelta ? '' : json.text ?? '', delta: false }
  if (json.type === 'response.completed') {
    const text = sawDelta ? '' : extractCodexResponseText(json.response)
    const usage = extractCodexUsage(json.response?.usage)
    return { text: text || undefined, delta: false, usage: usage || undefined }
  }
  return { delta: false }
}

function extractCodexUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const inputTokens = usage.input_tokens ?? undefined
  const outputTokens = usage.output_tokens ?? undefined
  const cacheReadTokens = usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.cached_input_tokens
    ?? usage.cache_read_input_tokens
    ?? usage.cached_tokens
    ?? findNumericField(usage, ['cached_tokens', 'cached_input_tokens', 'cache_read_input_tokens'])
  const cacheWriteTokens = usage.input_tokens_details?.cache_creation_tokens
    ?? usage.prompt_tokens_details?.cache_creation_tokens
    ?? usage.cache_creation_input_tokens
    ?? usage.cache_write_input_tokens
    ?? usage.cache_creation_tokens
    ?? findNumericField(usage, ['cache_creation_tokens', 'cache_creation_input_tokens', 'cache_write_input_tokens'])
  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined && cacheWriteTokens === undefined) return undefined
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

function findNumericField(value, names, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return undefined
  seen.add(value)
  for (const name of names) {
    if (typeof value[name] === 'number') return value[name]
  }
  for (const child of Object.values(value)) {
    const found = findNumericField(child, names, seen)
    if (found !== undefined) return found
  }
  return undefined
}

function extractCodexResponseText(response) {
  if (typeof response?.output_text === 'string') return response.output_text
  if (!Array.isArray(response?.output)) return ''
  return response.output
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .map((content) => content.text ?? '')
    .join('')
}

async function readCodexAccessToken() {
  return readOpenAICodexAccessToken()
}

function anthropicAdapter(provider) {
  const ctx = { providerId: provider.id, providerType: provider.type ?? 'anthropic' }
  const cacheTtl = normalizeCacheTtl(provider.cacheTtl)
  const buildBody = (messages, opts, { stream }) => {
    const systemText = [opts?.system, ...messages.filter((m) => m.role === 'system').map((m) => partsToPlainText(m.content))]
      .filter(Boolean)
      .join('\n\n')
    const system = systemText ? buildAnthropicSystem(systemText, cacheTtl) : undefined
    const apiMessages = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: toAnthropicContent(message),
      }))
    applyAnthropicMessageCacheControl(apiMessages, { ttl: cacheTtl, hasSystemBreakpoint: Boolean(system) })
    return {
      model: provider.model,
      max_tokens: 4096,
      ...(stream ? { stream: true } : {}),
      ...(system ? { system } : {}),
      messages: apiMessages,
    }
  }
  const url = `${trimRight(provider.baseURL ?? 'https://api.anthropic.com')}/v1/messages`
  const headers = () => ({
    'content-type': 'application/json',
    'x-api-key': provider.apiKey,
    'anthropic-version': '2023-06-01',
    // Required header when any cache_control uses ttl="1h". Harmless when 5m.
    ...(cacheTtl === '1h' ? { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' } : {}),
  })
  const countUrl = `${trimRight(provider.baseURL ?? 'https://api.anthropic.com')}/v1/messages/count_tokens`
  return {
    async complete(messages, opts) {
      if (!provider.apiKey) throw new Error('API key is required')
      const res = await fetchModel(url, { method: 'POST', headers: headers(), body: JSON.stringify(buildBody(messages, opts, { stream: false })) }, ctx)
      const json = await res.json()
      return Array.isArray(json.content)
        ? json.content.map((part) => part?.text ?? '').join('')
        : ''
    },
    async *stream(messages, opts) {
      if (!provider.apiKey) throw new Error('API key is required')
      const res = await fetchModel(url, { method: 'POST', headers: headers(), body: JSON.stringify(buildBody(messages, opts, { stream: true })) }, ctx)
      yield* parseAnthropicSse(res)
    },
    async countTokens(messages, opts) {
      if (!provider.apiKey) throw new Error('API key is required')
      const body = buildBody(messages, opts, { stream: false })
      delete (body as any).max_tokens
      delete (body as any).stream
      const res = await fetchModel(countUrl, { method: 'POST', headers: headers(), body: JSON.stringify(body) }, ctx)
      const json = await res.json()
      if (typeof json.input_tokens !== 'number') throw new Error('count_tokens returned no input_tokens')
      return { tokens: json.input_tokens, exact: true, source: 'anthropic count_tokens' }
    },
  }
}

function normalizeCacheTtl(value) {
  return value === '1h' ? '1h' : '5m'
}

const LANNR_CACHE_BOUNDARY = '\n<!-- LANNR_CACHE_BOUNDARY -->\n'

function cacheMarker(ttl) {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
}

function buildAnthropicSystem(systemText, ttl = '5m') {
  const marker = cacheMarker(ttl)
  const idx = systemText.indexOf(LANNR_CACHE_BOUNDARY)
  if (idx === -1) {
    return [{ type: 'text', text: systemText, cache_control: marker }]
  }
  const stable = systemText.slice(0, idx).trimEnd()
  const dynamic = systemText.slice(idx + LANNR_CACHE_BOUNDARY.length).trimStart()
  const blocks = []
  if (stable) blocks.push({ type: 'text', text: stable, cache_control: marker })
  if (dynamic) blocks.push({ type: 'text', text: dynamic })
  return blocks
}

// Place cache_control breakpoints across the conversation so multi-turn
// sessions reuse the full prefix, not just the last user turn. Anthropic
// allows up to 4 breakpoints per request; we use:
//   - system block (1, set in buildAnthropicSystem)
//   - last 3 non-system messages (here)
// On a 5-turn conversation this caches the entire history through turn N-1
// instead of only the most recent user message. Mirrors hermes_agent's
// `system_and_3` strategy.
function applyAnthropicMessageCacheControl(messages, { ttl = '5m', hasSystemBreakpoint = true } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return
  const marker = cacheMarker(ttl)
  // Reserve 1 of the 4 slots for system; place up to 3 on the message tail.
  const budget = Math.max(1, 4 - (hasSystemBreakpoint ? 1 : 0))
  const tailIndices = []
  for (let i = messages.length - 1; i >= 0 && tailIndices.length < budget; i--) {
    tailIndices.unshift(i)
  }
  for (const i of tailIndices) markMessageForCache(messages[i], marker)
}

function markMessageForCache(message, marker) {
  if (!message) return
  if (typeof message.content === 'string') {
    message.content = [{ type: 'text', text: message.content, cache_control: marker }]
    return
  }
  if (Array.isArray(message.content) && message.content.length > 0) {
    const tail = message.content[message.content.length - 1]
    if (tail && typeof tail === 'object') tail.cache_control = marker
  }
}

function googleAdapter(provider) {
  const ctx = { providerId: provider.id, providerType: provider.type ?? 'google' }
  return {
    async complete(messages, opts) {
      if (!provider.apiKey) throw new Error('API key is required')
      const contents = toGoogleContents(messages, opts?.system)
      const url = `${trimRight(provider.baseURL ?? 'https://generativelanguage.googleapis.com/v1beta')}/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`
      const res = await fetchModel(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents }),
      }, ctx)
      const json = await res.json()
      return json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? ''
    },
    async *stream(messages, opts) {
      if (!provider.apiKey) throw new Error('API key is required')
      const contents = toGoogleContents(messages, opts?.system)
      const url = `${trimRight(provider.baseURL ?? 'https://generativelanguage.googleapis.com/v1beta')}/models/${encodeURIComponent(provider.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(provider.apiKey)}`
      const res = await fetchModel(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents }),
      }, ctx)
      yield* parseSse(res, (json) => json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '')
    },
    async countTokens(messages, opts) {
      if (!provider.apiKey) throw new Error('API key is required')
      const contents = toGoogleContents(messages, opts?.system)
      const url = `${trimRight(provider.baseURL ?? 'https://generativelanguage.googleapis.com/v1beta')}/models/${encodeURIComponent(provider.model)}:countTokens?key=${encodeURIComponent(provider.apiKey)}`
      const res = await fetchModel(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents }),
      }, ctx)
      const json = await res.json()
      if (typeof json.totalTokens !== 'number') throw new Error('countTokens returned no totalTokens')
      return { tokens: json.totalTokens, exact: true, source: 'google countTokens' }
    },
  }
}

function openaiChatAdapter({ providerId, providerType, model, baseURL, apiKey, endpoint, promptCacheKey }) {
  if (endpoint === 'responses') {
    return openaiResponsesAdapter({ providerId, providerType, model, baseURL, apiKey, promptCacheKey })
  }
  const ctx = { providerId, providerType: providerType ?? 'openai' }
  const url = `${normalizeOpenAIBaseURL(baseURL)}/chat/completions`
  const headers = () => {
    if (!apiKey) throw new Error('API key is required')
    return { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` }
  }
  const buildBody = (messages, opts, { stream }) => {
    const requestPromptCacheKey = resolvePromptCacheKey(opts?.promptCacheKey, promptCacheKey)
    return {
      model,
      messages: toOpenAIChatMessages(messages, opts?.system),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      // `prompt_cache_key` routes identical-prefix requests to the same OpenAI
      // cache shard. `user` is the legacy field; `safety_identifier` is the
      // GPT-5 / Responses-era equivalent — sending both costs nothing and lets
      // newer models route correctly.
      ...(requestPromptCacheKey ? {
        prompt_cache_key: requestPromptCacheKey,
        user: requestPromptCacheKey,
        safety_identifier: requestPromptCacheKey,
      } : {}),
    }
  }
  return {
    async complete(messages, opts) {
      const res = await fetchModel(url, { method: 'POST', headers: headers(), body: JSON.stringify(buildBody(messages, opts, { stream: false })) }, ctx)
      const json = await res.json()
      return json.choices?.[0]?.message?.content ?? ''
    },
    async *stream(messages, opts) {
      const res = await fetchModel(url, { method: 'POST', headers: headers(), body: JSON.stringify(buildBody(messages, opts, { stream: true })) }, ctx)
      yield* parseOpenAIChatStream(res)
    },
  }
}

function openaiResponsesAdapter({ providerId, providerType, model, baseURL, apiKey, promptCacheKey }) {
  const ctx = { providerId, providerType: providerType ?? 'openai' }
  const url = `${normalizeOpenAIBaseURL(baseURL)}/responses`
  const headers = () => {
    if (!apiKey) throw new Error('API key is required')
    return { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` }
  }
  const buildBody = (messages, opts, { stream }) => {
    const instructions = [opts?.system, ...messages.filter((m) => m.role === 'system').map((m) => partsToPlainText(m.content))]
      .filter(Boolean)
      .join('\n\n')
    const requestPromptCacheKey = resolvePromptCacheKey(opts?.promptCacheKey, promptCacheKey)
    return {
      model,
      ...(instructions ? { instructions } : {}),
      input: messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: toOpenAIResponsesContent(message),
        })),
      store: false,
      ...(requestPromptCacheKey ? {
        prompt_cache_key: requestPromptCacheKey,
        safety_identifier: requestPromptCacheKey,
      } : {}),
      ...(stream ? { stream: true } : {}),
    }
  }
  return {
    async complete(messages, opts) {
      const res = await fetchModel(url, { method: 'POST', headers: headers(), body: JSON.stringify(buildBody(messages, opts, { stream: false })) }, ctx)
      const json = await res.json()
      return extractCodexResponseText(json)
    },
    async *stream(messages, opts) {
      const res = await fetchModel(url, { method: 'POST', headers: headers(), body: JSON.stringify(buildBody(messages, opts, { stream: true })) }, ctx)
      yield* parseCodexResponsesStream(res)
    },
  }
}

function normalizeOpenAIBaseURL(baseURL) {
  const trimmed = trimRight(baseURL)
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

function toOpenAIChatMessages(messages, system = '') {
  const out = []
  if (system) out.push({ role: 'system', content: system })
  for (const message of messages) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: partsToPlainText(message.content) })
    } else if (message.role === 'assistant') {
      out.push({ role: 'assistant', content: toOpenAIChatContent(message) })
    } else if (message.role === 'tool') {
      out.push({ role: 'user', content: toolContentText(message) })
    } else {
      out.push({ role: 'user', content: toOpenAIChatContent(message) })
    }
  }
  return out
}

async function* parseOpenAIChatStream(res) {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue
      let json
      try { json = JSON.parse(data) } catch { continue }
      const text = json.choices?.[0]?.delta?.content
      if (typeof text === 'string' && text) yield { text }
      if (json.usage) {
        const usage = extractCodexUsage(json.usage)
        if (usage) yield { usage }
      }
    }
  }
}

function toGoogleContents(messages, system = '') {
  const contents = []
  if (system) {
    contents.push({ role: 'user', parts: [{ text: `System instructions:\n${system}` }] })
  }
  for (const message of messages) {
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: toGoogleParts(message),
    })
  }
  return contents
}

function trimRight(value) {
  return String(value).replace(/\/+$/, '')
}

async function* parseAnthropicSse(res) {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let inputTokens
  let cacheReadTokens
  let cacheWriteTokens

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue
      const json = JSON.parse(data)
      if (json.type === 'message_start' && json.message?.usage) {
        inputTokens = json.message.usage.input_tokens
        cacheReadTokens = json.message.usage.cache_read_input_tokens
        cacheWriteTokens = json.message.usage.cache_creation_input_tokens
      }
      if (json.type === 'content_block_delta' && json.delta?.text) {
        yield { text: json.delta.text }
      }
      if (json.type === 'message_delta' && json.usage) {
        yield { usage: { inputTokens, outputTokens: json.usage.output_tokens, cacheReadTokens, cacheWriteTokens } }
      }
    }
  }
}

async function* parseSse(res, extractText) {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue
      const text = extractText(JSON.parse(data))
      if (text) yield text
    }
  }
}
