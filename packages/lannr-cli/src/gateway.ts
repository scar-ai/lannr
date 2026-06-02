import { randomUUID } from 'node:crypto'
import { createContextEngine, summarizationPrompt } from './agents/context-engine.js'
import { createAgentRuntime } from './agents/runtime.js'
import { addUsage, appendSessionTurn, mergeAssistantMessage, normalizeSessionId, zeroUsage } from './agents/sessions.js'
import { compressTrajectory, totalChars } from './agents/trajectory.js'
import { loadConfig } from './config.js'
import { createModelAdapter } from './llm/model-adapter.js'
import { rateBus } from './llm/rate-bus.js'
import { retryAfterMsFromHeaders } from './llm/rate-limits.js'
import { createCheckpointManager } from './safety/checkpoint.js'
import { getContextEngineEnabled } from './settings.js'
import { buildUserContent, extractImagePaths } from './agents/image-input.js'

// ── Error classification (inspired by openclaw/hermes error taxonomy) ──────────

const RETRY_CATEGORIES = new Set(['rate_limit', 'server_error', 'network', 'overloaded'])
const CONTINUATION_DONE = 'LANNR_DONE'

// Events yielded live to consumers as they arrive (instead of being buffered
// until the agent loop's bulk re-yield). The TUI relies on this for real-time
// tool-call rendering during `lannr chat --agent x`.
const LIVE_EVENT_TYPES = new Set([
  'lannr:tool:call',
  'lannr:tool:result',
  'lannr:tool:error',
  'lannr:thinking',
  'lannr:checkpoint',
  'lannr:model:usage',
  'lannr:program',
  'lannr:rate:state',
])

function classifyError(error) {
  const msg = String(error?.message ?? error ?? '').toLowerCase()
  const status = error?.status ?? error?.statusCode ?? error?.response?.status
  const headers = error?.headers ?? error?.response?.headers
  // Provider-specific Retry-After / x-ratelimit-reset / anthropic-ratelimit-*-reset
  // gives us the real backoff. Falls back to a static default per category.
  const headerDelay = retryAfterMsFromHeaders(headers, error?.providerType)

  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid.{0,20}api.{0,10}key|authentication failed/i.test(msg)) {
    return { category: 'auth', retryable: false, baseDelay: 0 }
  }
  if (status === 429 || /rate.?limit|too many requests/i.test(msg)) {
    // Cap at 60s — runaway resets (e.g. 1h windows) should yield to operator.
    const baseDelay = headerDelay != null ? Math.min(headerDelay, 60_000) : 10_000
    return { category: 'rate_limit', retryable: true, baseDelay }
  }
  if (status === 400 && /context.?length|context.?window|too many tokens|max.?tokens|input.{0,30}too long/i.test(msg)) {
    return { category: 'context_overflow', retryable: false, baseDelay: 0 }
  }
  if (status === 503 || /overloaded|service.{0,10}unavailable/i.test(msg)) {
    const baseDelay = headerDelay != null ? Math.min(headerDelay, 30_000) : 5_000
    return { category: 'overloaded', retryable: true, baseDelay }
  }
  if (status === 500 || status === 502 || /internal server error|bad gateway/i.test(msg)) {
    return { category: 'server_error', retryable: true, baseDelay: headerDelay ?? 3_000 }
  }
  if (/econnreset|enotfound|econnrefused|etimedout|network|connection/i.test(msg)) {
    return { category: 'network', retryable: true, baseDelay: 2_000 }
  }
  return { category: 'unknown', retryable: false, baseDelay: 0 }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function jitteredDelay(baseMs, attempt) {
  const exponential = baseMs * Math.pow(2, attempt - 1)
  const capped = Math.min(exponential, 120_000)
  return Math.floor(capped * (0.5 + Math.random() * 0.5))
}

// ── Streaming with retry (errors before first event are retried) ───────────────

async function* streamTurnWithRetry(lannr, messages, onResult, { maxRetries = 3 } = {}) {
  let attempt = 0
  while (true) {
    let receivedAnyEvent = false
    let capturedResult = null
    try {
      for await (const event of lannr.stream(messages, (r) => { capturedResult = r })) {
        receivedAnyEvent = true
        yield event
      }
      onResult?.(capturedResult)
      return
    } catch (error) {
      const classified = classifyError(error)
      attempt++
      // Only retry if no events were received yet (pre-stream failure) and error is retryable
      if (receivedAnyEvent || !classified.retryable || attempt > maxRetries) {
        throw error
      }
      const delay = jitteredDelay(classified.baseDelay, attempt)
      yield { type: 'lannr:retry', attempt, category: classified.category, delayMs: delay }
      await sleep(delay)
    }
  }
}

// ── History management ────────────────────────────────────────────────────────
// Trajectory compression: summarize old turns + trim bulky tool blobs once the
// running message history exceeds the budget. Replaces the prior char-cap trim.

const HISTORY_CHAR_LIMIT = 320_000

function trimMessageHistory(messages) {
  if (totalChars(messages) <= HISTORY_CHAR_LIMIT) return messages
  return compressTrajectory(messages, { charBudget: HISTORY_CHAR_LIMIT })
}

// Opt-in (settings.contextEngineEnabled): replaces the static char-budget trim
// with a tiered soft/hard engine that can call the agent's own model to
// summarize the elided middle when the conversation exceeds the hard budget.
async function buildContextEngine(runtime) {
  if (!(await getContextEngineEnabled())) return null
  const summarize = async (middle) => {
    const adapter = createModelAdapter(runtime.provider, runtime.model)
    const prompt = summarizationPrompt(middle)
    return adapter.complete([{ role: 'user', content: prompt }], { promptCacheKey: runtime.promptCacheKey })
  }
  return createContextEngine({ summarize })
}

// ── Sanitize messages (strip lone surrogates that crash JSON serialization) ────

// eslint-disable-next-line no-control-regex
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

function sanitizeText(value) {
  return String(value ?? '').replace(LONE_SURROGATE_RE, '�')
}

function sanitizeMessages(messages) {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      const sanitized = sanitizeText(m.content)
      return sanitized === m.content ? m : { ...m, content: sanitized }
    }
    if (Array.isArray(m.content)) {
      let changed = false
      const nextParts = m.content.map((part) => {
        if (typeof part === 'string') {
          const s = sanitizeText(part)
          if (s !== part) changed = true
          return s
        }
        if (part?.type === 'text') {
          const s = sanitizeText(part.text ?? '')
          if (s !== part.text) { changed = true; return { ...part, text: s } }
          return part
        }
        return part
      })
      return changed ? { ...m, content: nextParts } : m
    }
    return m
  })
}

// ── Gateway ───────────────────────────────────────────────────────────────────

export async function createLannrGateway(overrides: Record<string, any> = {}) {
  const config = await loadConfig(overrides)

  const streamEventsRaw = async function* (request: Record<string, any> = {}, onFinal?: (result: any) => void) {
    const runtime = await createAgentRuntime({
      agentId: request.agent ?? request.agent_id,
      overrides: {
        ...(request.provider || request.provider_id ? { provider: request.provider ?? request.provider_id } : {}),
        ...(request.model || request.model_id ? { model: request.model ?? request.model_id } : {}),
        session: normalizeSessionId(request.session ?? request.session_id) ?? null,
      },
    })

    const runtimeInfo = {
      agentId: runtime.agent.id,
      providerId: runtime.provider.id,
      model: runtime.model,
    }

    const contextEngine = await buildContextEngine(runtime)

    const checkpointManager = createCheckpointManager(runtime.agent, { enabled: request.checkpoint !== false })
    const turnId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    try {
      const manifest = await checkpointManager.snapshot(turnId, null)
      if (manifest) {
        yield {
          type: 'lannr:checkpoint',
          turnId,
          parentTurnId: null,
          fileCount: manifest.files.length,
          runtime: runtimeInfo,
        }
      }
    } catch (error) {
      yield {
        type: 'lannr:checkpoint:error',
        turnId,
        message: error instanceof Error ? error.message : String(error),
        runtime: runtimeInfo,
      }
    }

    let messages = await messagesForRuntime(runtime.systemPrompt, request)
    const turnContextSections = []
    if (runtime.perTurnContext) turnContextSections.push(runtime.perTurnContext)
    // Append dynamic context as a trailing user message instead of folding it
    // into the system prompt. The system + prior history stays byte-identical
    // across requests so OpenAI / Anthropic prefix caches hit; only this tail
    // (~few-hundred tokens) is uncached.
    if (turnContextSections.length > 0) {
      messages = [...messages, { role: 'user', content: turnContextSections.join('\n\n') }]
    }
    let final = null
    let lastAnswer = ''
    let stableAnswerStreak = 0
    const maxTurns = normalizePositiveInteger(request.max_agent_turns ?? request.maxAgentTurns, 6)
    const MAX_STABLE_STREAK = 3
    let pendingFinalEvents = null

    // Subscribe to rate-limit publications from the active provider's adapter.
    // Buffer them and yield as `lannr:rate:state` events between model chunks
    // so the UI footer can show live RPM/TPM. Filter by providerId so a
    // shared bus across many gateways stays scoped. Detached in finally.
    const pendingRateStates = []
    const onRateState = ({ providerId, state }) => {
      if (providerId !== runtime.provider.id) return
      pendingRateStates.push(state)
    }
    rateBus.on('state', onRateState)
    let rateSubscribed = true
    // Seed with any state already cached for this provider (e.g. captured by
    // a prior turn) so the UI sees the freshest data even before any new HTTP
    // round-trip on this turn.
    const seedState = rateBus.get(runtime.provider.id)
    if (seedState) pendingRateStates.push(seedState)

    const drainRateStates = function* () {
      while (pendingRateStates.length > 0) {
        const state = pendingRateStates.shift()
        yield { type: 'lannr:rate:state', state, runtime: runtimeInfo }
      }
    }

    try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const events = []
      let result = null
      let hadActions = false
      let answer = ''

      // Live-streaming state for this turn. We translate the core's per-token
      // `lannr:model:delta` into `lannr:answer:delta` so the TUI / OpenAI-style
      // consumers can render the answer as it's produced. The pump scans the
      // running buffer for `<program` *anywhere* (not just at the prefix) so a
      // program block that follows prose is never leaked, holds back trailing
      // partial `<p…` that could become `<program`, and tracks an
      // `emittedLen` pointer that only moves forward — guaranteeing each
      // character is emitted at most once.
      //
      // `streamLiveDeltas` gates whether we pump model:delta out live. It
      // starts false so the model's pre-program intro narration ("Let me
      // check…") is *buffered silently* instead of being streamed and then
      // erased when `<program>` arrives — which is what produced the
      // "bad output → clears → final output appears" flicker. After the
      // first tool:result/error fires we flip it true: post-tool prose
      // is the real final answer, so we stream it as tokens arrive. Pure-
      // prose turns (no program at all) never flip the flag; their full
      // buffered response is emitted by the end-of-turn flush below.
      const live = { buffer: '', emittedLen: 0, committed: false, discarded: false }
      let streamLiveDeltas = false

      // Trim history before each non-first turn to avoid context overflow.
      // When the context engine is enabled, stream its events live so the UI
      // can render a "Compacting…" indicator while a model summary is in flight.
      if (turn > 0) {
        const sanitized = sanitizeMessages(messages)
        if (contextEngine) {
          let nextMessages = sanitized
          for await (const event of contextEngine.compactStream(sanitized)) {
            if (event.type === 'lannr:compaction:result') {
              nextMessages = event.messages
              continue
            }
            yield { ...event, runtime: runtimeInfo }
          }
          messages = nextMessages
        } else {
          messages = trimMessageHistory(sanitized)
        }
      }

      for await (const event of streamTurnWithRetry(runtime.lannr, messages, (r) => { result = r })) {
        // Drain any rate-limit publications captured by adapter fetches since
        // the last yield. Keeps the UI footer current without bolting an
        // out-of-band channel onto the streamEvents contract.
        yield* drainRateStates()
        if (event.type === 'lannr:retry') {
          // Surface retry info but don't treat as a user-visible event
          continue
        }
        if (event.type === 'lannr:program' || event.type === 'lannr:tool:call') {
          hadActions = true
          live.discarded = true
        }
        if (event.type === 'lannr:answer') answer = event.text ?? ''

        // After a tool runs, lannr.stream() may iterate again with a fresh
        // model response (the final prose answer). Reset the pump so that
        // post-tool iteration can stream live too. The TUI already cleared
        // its display when lannr:program fired, so the next deltas accumulate
        // from empty without leaking the prior program body.
        if (event.type === 'lannr:tool:result' || event.type === 'lannr:tool:error') {
          live.buffer = ''
          live.emittedLen = 0
          live.committed = false
          live.discarded = false
          streamLiveDeltas = true
        }

        // Live-surface tool/thinking/usage/checkpoint/program events as they
        // arrive so the TUI can render activity in real time. These are not
        // pushed into `events[]`, so the end-of-turn bulk re-yield and the
        // `pendingFinalEvents` carry-over won't double-emit them.
        if (LIVE_EVENT_TYPES.has(event.type)) {
          yield { ...event, runtime: runtimeInfo }
          continue
        }

        events.push(event)

        if (event.type === 'lannr:model:delta' && !live.discarded) {
          live.buffer += event.text ?? ''
          // Buffer pre-tool prose silently; pump live once we know we're in
          // the post-tool "final answer" phase.
          if (streamLiveDeltas) {
            for (const text of pumpLiveDelta(live, false)) {
              yield { type: 'lannr:answer:delta', text, runtime: runtimeInfo }
            }
          }
        }
      }

      // End-of-turn flush: emit any safe remainder. The pump is idempotent and
      // only advances `emittedLen` forward, so re-running it here can never
      // double-emit text already streamed live.
      if (!live.discarded && !isContinuationDone(answer)) {
        for (const text of pumpLiveDelta(live, true)) {
          yield { type: 'lannr:answer:delta', text, runtime: runtimeInfo }
        }
      }

      const controlDone = isContinuationDone(answer)
      if (controlDone) {
        if (pendingFinalEvents) {
          for (const event of stripModelDeltas(pendingFinalEvents)) yield { ...event, runtime: runtimeInfo }
          pendingFinalEvents = null
        }
        break
      }

      if (!hadActions) {
        if (pendingFinalEvents) {
          for (const event of stripAnswerEvents(pendingFinalEvents)) yield { ...event, runtime: runtimeInfo }
          pendingFinalEvents = null
        }
        final = result ?? final
        for (const event of stripModelDeltas(events)) yield { ...event, runtime: runtimeInfo }
        break
      }

      if (pendingFinalEvents) {
        for (const event of stripAnswerEvents(pendingFinalEvents)) yield { ...event, runtime: runtimeInfo }
        pendingFinalEvents = null
      }

      final = result ?? final

      // Tool loop detection: if the answer is unchanged across consecutive action turns, stop
      if (hadActions && answer && answer === lastAnswer) {
        stableAnswerStreak++
        if (stableAnswerStreak >= MAX_STABLE_STREAK) {
          for (const event of stripModelDeltas(events)) yield { ...event, runtime: runtimeInfo }
          break
        }
      } else {
        stableAnswerStreak = 0
      }

      if (answer) lastAnswer = answer
      messages = appendAssistantAnswer(result?.messages ?? messages, answer)

      if (turn + 1 >= maxTurns) {
        for (const event of stripModelDeltas(events)) yield { ...event, runtime: runtimeInfo }
        break
      }

      pendingFinalEvents = events
      messages = appendContinuationCheck(messages)
    }

    if (final && lastAnswer && final.answer !== lastAnswer) final = { ...final, answer: lastAnswer }
    // One last drain before we close the subscription, so any state captured
    // by the model's final HTTP call still reaches the UI.
    yield* drainRateStates()
    onFinal?.(final)
    } finally {
      if (rateSubscribed) {
        rateBus.off('state', onRateState)
        rateSubscribed = false
      }
    }
  }

  const streamEvents = async function* (request: Record<string, any> = {}, onFinal?: (result: any) => void) {
    const sessionId = request.session ?? request.session_id
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      yield* streamEventsRaw(request, onFinal)
      return
    }

    const startedAt = new Date().toISOString()
    const events = []
    let final = null
    let runtimeInfo = null
    let usage = zeroUsage()
    // Last single request's usage (replaced, not summed) — this is the prompt's
    // window occupancy, which /context persists and reports per session.
    let lastUsage = null
    const publicMessages = await normalizeMessages(request.messages ?? promptToMessages(request.prompt ?? request.message))

    try {
      for await (const event of streamEventsRaw(request, (result) => {
        final = result
        onFinal?.(result)
      })) {
        runtimeInfo = event.runtime ?? runtimeInfo
        events.push(event)
        if (event.type === 'lannr:model:usage' && event.usage) { usage = addUsage(usage, event.usage); lastUsage = event.usage }
        yield event
      }
    } finally {
      if (runtimeInfo) {
        const agent = config.agents[runtimeInfo.agentId]
        if (agent) {
          await appendSessionTurn(agent, normalizeSessionId(sessionId), {
            id: completionId('turn'),
            startedAt,
            endedAt: new Date().toISOString(),
            runtime: runtimeInfo,
            request: {
              agent: request.agent ?? request.agent_id ?? null,
              provider: request.provider ?? request.provider_id ?? null,
              model: request.model ?? request.model_id ?? null,
              session: normalizeSessionId(sessionId),
            },
            messages: mergeAssistantMessage(publicMessages, final?.answer),
            events,
            final,
            usage,
            lastUsage,
          })
        }
      }
    }
  }

  return {
    config,
    listAgents() {
      return Object.values(config.agents).map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        provider: agent.provider,
        model: agent.providerConfig?.model ?? agent.model ?? null,
        workspace: agent.workspace,
        default: agent.id === config.defaultAgentId,
        aliases: agent.aliases ?? [],
      }))
    },
    async complete(request: Record<string, any> = {}) {
      let answer = ''
      let final = null
      let runtimeInfo = null
      for await (const event of streamEvents(request, (result) => { final = result })) {
        runtimeInfo = event.runtime ?? runtimeInfo
        if (event.type === 'lannr:answer' && event.text) {
          answer = event.text
        }
      }
      return {
        id: completionId('chatcmpl'),
        object: 'chat.completion',
        created: unixTime(),
        model: runtimeInfo?.model ?? final?.model ?? 'lannr',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: answer },
            finish_reason: 'stop',
          },
        ],
        usage: null,
        lannr: {
          agent: runtimeInfo?.agentId ?? null,
          provider: runtimeInfo?.providerId ?? null,
          confidence: final?.confidence ?? null,
          stats: final?.stats ?? null,
        },
      }
    },
    async *stream(request: Record<string, any> = {}) {
      let runtimeInfo = null
      yield chatChunk({ model: 'lannr', delta: { role: 'assistant' }, finishReason: null })
      for await (const event of streamEvents(request, undefined)) {
        runtimeInfo = event.runtime ?? runtimeInfo
        if (event.type === 'lannr:answer:delta') {
          yield chatChunk({ model: runtimeInfo?.model ?? 'lannr', delta: { content: event.text }, finishReason: null })
        }
      }
      yield chatChunk({ model: runtimeInfo?.model ?? 'lannr', delta: {}, finishReason: 'stop' })
    },
    streamEvents,
    // User-triggered compaction (via /compact). Always runs the LLM summarizer
    // path on the supplied messages, ignoring the contextEngineEnabled flag and
    // the soft/hard token thresholds.
    async *compact(request: Record<string, any> = {}) {
      const runtime = await createAgentRuntime({
        agentId: request.agent ?? request.agent_id,
        overrides: {
          ...(request.provider || request.provider_id ? { provider: request.provider ?? request.provider_id } : {}),
          ...(request.model || request.model_id ? { model: request.model ?? request.model_id } : {}),
          session: normalizeSessionId(request.session ?? request.session_id) ?? null,
        },
      })
      const runtimeInfo = {
        agentId: runtime.agent.id,
        providerId: runtime.provider.id,
        model: runtime.model,
      }
      const summarize = async (middle) => {
        const adapter = createModelAdapter(runtime.provider, runtime.model)
        const prompt = summarizationPrompt(middle)
        return adapter.complete([{ role: 'user', content: prompt }], { promptCacheKey: runtime.promptCacheKey })
      }
      const engine = createContextEngine({ summarize })
      const messages = await normalizeMessages(request.messages ?? [])
      for await (const event of engine.compactStream(messages, { force: true })) {
        yield { ...event, runtime: runtimeInfo }
      }
    },
  }
}

async function messagesForRuntime(systemPrompt, request: Record<string, any>) {
  return [
    { role: 'system', content: systemPrompt },
    ...await normalizeMessages(request.messages ?? promptToMessages(request.prompt ?? request.message)),
  ]
}

function promptToMessages(prompt) {
  const content = typeof prompt === 'string' ? prompt : ''
  return content ? [{ role: 'user', content }] : []
}

async function normalizeMessages(messages) {
  if (!Array.isArray(messages)) throw new Error('messages must be an array')
  return Promise.all(messages.map(async (message) => {
    const role = normalizeRole(message.role)
    return {
      role,
      content: await normalizeContent(message.content, { parseImages: role === 'user' }),
    }
  }))
}

function normalizeRole(role) {
  if (role === 'system' || role === 'assistant' || role === 'tool') return role
  return 'user'
}

async function normalizeContent(content, { parseImages = false } = {}) {
  if (typeof content === 'string') {
    if (!parseImages) return content
    const { cleanedText, images } = await extractImagePaths(content)
    return images.length > 0 ? buildUserContent({ text: cleanedText, images }) : content
  }
  if (Array.isArray(content)) {
    // Preserve multipart shape (e.g. user-attached images) so adapters can map
    // them into provider-specific image payloads downstream.
    const parts = content
      .map((part) => {
        if (typeof part === 'string') return part ? { type: 'text', text: part } : null
        if (part?.type === 'image' && part.data && part.mediaType) return part
        if (part?.type === 'text' || typeof part?.text === 'string') {
          return { type: 'text', text: String(part.text ?? '') }
        }
        return null
      })
      .filter(Boolean)
    if (parts.length === 0) return ''
    if (parts.length === 1 && parts[0].type === 'text') return parts[0].text
    return parts
  }
  if (content == null) return ''
  return String(content)
}

function appendAssistantAnswer(messages, answer) {
  const text = typeof answer === 'string' ? answer.trim() : ''
  if (!text) return messages
  return [...messages, { role: 'assistant', content: answer }]
}

function appendContinuationCheck(messages) {
  return [
    ...messages,
    {
      role: 'user',
      content: [
        'Internal continuation check for this same user-facing turn.',
        'If the user request is fully handled, reply with exactly LANNR_DONE.',
        'If more inspection, tool use, verification, or follow-up work is needed, continue now using the available tools.',
        'Do not summarize progress or ask the user to continue unless you are actually blocked.',
      ].join('\n'),
    },
  ]
}

function isContinuationDone(answer) {
  return String(answer ?? '').trim() === CONTINUATION_DONE
}

function stripAnswerEvents(events) {
  return events.filter((event) => event.type !== 'lannr:answer' && event.type !== 'lannr:answer:delta' && event.type !== 'lannr:model:delta')
}

function stripModelDeltas(events) {
  // Drop synthesized-or-original token deltas from re-yields so consumers
  // never see the same text twice. lannr:answer:delta is only ever yielded
  // live by the pump; lannr:model:delta is internal to the core.
  return events.filter((event) => event.type !== 'lannr:model:delta' && event.type !== 'lannr:answer:delta')
}

const PROGRAM_TAG = '<program'
const FENCE = '```'

// Lannr tool-call signature.  `$bash`, `$readFile`, etc. are the dollar-prefix
// bindings the model uses *only* inside a <program> block.  If we see one in
// the live stream (typically inside a markdown ```ts fence the model wrote
// while "recapping" its program after the tool ran), it's program code that
// must never reach the user.
const LANNR_CALL_RE = /(?:await\s+|return\s+|=\s*|^\s*|\(\s*|,\s*)\$[A-Za-z_]\w*\s*\(/m

// Pump safe text out of `live.buffer` into the user-visible stream.
// Returns an array of text chunks to yield (often 0 or 1).
//
// Behavior:
//   - Scans the buffer for `<program` *anywhere* past `emittedLen`. If found,
//     emits any safe prose preceding it, then marks the stream discarded.
//   - Holds back inside markdown code fences (```…```) until they close, then
//     inspects the contents: if a lannr tool-call signature (`await $bash(…)`,
//     `return $readFile(…)`, etc.) appears, the entire fenced block is dropped
//     and streaming resumes with the text that follows it.  Safe fences are
//     emitted normally once closed.
//   - Holds back trailing partial `<p…` or `` ` `` `` `` `` that could still
//     grow into `<program` or ```` ``` ```` (only when not at end of stream).
//   - Until the first emission ("commit"), also guards against `LANNR_DONE`
//     continuation-check replies; once committed, every safe character is
//     emitted exactly once.
//   - `emittedLen` only ever moves forward, so this function is idempotent:
//     re-running it (e.g. during the end-of-turn flush) cannot double-emit.
function pumpLiveDelta(live, atEnd) {
  if (live.discarded) return []
  const out = []

  // Iterate so that handling one event (e.g. dropping a leaked fence) can
  // immediately surface more safe content that followed it.
  while (true) {
    const progIdx = live.buffer.indexOf(PROGRAM_TAG, live.emittedLen)
    const fenceOpen = live.buffer.indexOf(FENCE, live.emittedLen)

    // Handle whichever sentinel appears first in the buffer.
    const firstIsProg = progIdx >= 0 && (fenceOpen < 0 || progIdx < fenceOpen)

    if (firstIsProg) {
      emitPrefix(live, out, progIdx)
      live.emittedLen = live.buffer.length
      live.discarded = true
      return out
    }

    if (fenceOpen >= 0) {
      const fenceClose = live.buffer.indexOf(FENCE, fenceOpen + FENCE.length)
      if (fenceClose < 0) {
        if (atEnd) break  // unterminated fence at end-of-stream → emit as-is
        emitRange(live, out, live.emittedLen, fenceOpen)
        return out
      }
      const inner = live.buffer.slice(fenceOpen + FENCE.length, fenceClose)
      if (LANNR_CALL_RE.test(inner)) {
        emitPrefix(live, out, fenceOpen)
        live.emittedLen = fenceClose + FENCE.length
        continue
      }
      // Safe fence — fall through and emit up to its end normally.
    }
    break
  }

  const safeEnd = sliceBeforeAmbiguousTail(live.buffer, live.buffer.length, atEnd)
  if (safeEnd <= live.emittedLen) return out
  emitRange(live, out, live.emittedLen, safeEnd)
  return out
}

// Emit `live.buffer[emittedLen..end]` (subject to the not-yet-committed gate)
// and advance emittedLen.  Used when a sentinel (`<program`, leaked fence) has
// been detected at position `end` and we want to flush any safe prose first.
function emitPrefix(live, out, end) {
  emitRange(live, out, live.emittedLen, end)
}

function emitRange(live, out, start, end) {
  if (end <= start) return
  const candidate = live.buffer.slice(start, end)
  if (!live.committed) {
    const decision = classifyLeadingPrefix(candidate)
    if (decision === 'wait') return
    if (decision === 'discard') {
      live.discarded = true
      live.emittedLen = live.buffer.length
      return
    }
    live.committed = true
  }
  out.push(candidate)
  live.emittedLen = end
}

// Return the largest index ≤ `limit` such that the suffix beyond it cannot be
// the start of `<program` or ```` ``` ````.  When `atEnd` is true, no hold-back
// is needed (the stream is finished).
function sliceBeforeAmbiguousTail(buffer, limit, atEnd = false) {
  if (atEnd) return limit
  let safe = limit
  const lt = buffer.lastIndexOf('<', limit - 1)
  if (lt >= 0) {
    const tail = buffer.slice(lt, limit)
    if (tail.length < PROGRAM_TAG.length && PROGRAM_TAG.startsWith(tail)) {
      safe = Math.min(safe, lt)
    }
  }
  const bt = buffer.lastIndexOf('`', limit - 1)
  if (bt >= 0) {
    const tail = buffer.slice(bt, limit)
    if (tail.length < FENCE.length && FENCE.startsWith(tail)) {
      safe = Math.min(safe, bt)
    }
  }
  return safe
}

// Decide whether the leading characters of an as-yet-uncommitted buffer are
// safe to start streaming.  Only used before the first emission of a turn.
//   'commit'  → safe to start streaming
//   'discard' → it's `<program>` or `LANNR_DONE`; suppress
//   'wait'    → still ambiguous, keep buffering
function classifyLeadingPrefix(buffer) {
  const trimmed = buffer.trimStart()
  if (!trimmed) return 'wait'
  if (trimmed.startsWith('<')) {
    if (trimmed.length >= PROGRAM_TAG.length) {
      return trimmed.startsWith(PROGRAM_TAG) ? 'discard' : 'commit'
    }
    return PROGRAM_TAG.startsWith(trimmed) ? 'wait' : 'commit'
  }
  if (trimmed.startsWith('`')) {
    // A partial backtick run could still grow into a ``` fence (which the
    // pump's fence handler needs to inspect before committing).  Wait until
    // we have at least 3 chars to decide.
    if (trimmed.length < FENCE.length) return FENCE.startsWith(trimmed) ? 'wait' : 'commit'
    return trimmed.startsWith(FENCE) ? 'wait' : 'commit'
  }
  if (CONTINUATION_DONE.startsWith(trimmed)) {
    return trimmed.length >= CONTINUATION_DONE.length ? 'discard' : 'wait'
  }
  return 'commit'
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) return fallback
  return Math.min(number, 20)
}

function chatChunk({ model, delta, finishReason }) {
  return {
    id: completionId('chatcmpl'),
    object: 'chat.completion.chunk',
    created: unixTime(),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function completionId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function unixTime() {
  return Math.floor(Date.now() / 1000)
}
