import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { assertSafeUrl } from '../safety/url-safety.js'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_FETCH_BYTES = 512_000

export function toolConfigPath({ root }: Record<string, any> = {}) {
  return resolve(root ?? homedir(), '.lannr/tools.json')
}

export async function loadToolConfig(options: Record<string, any> = {}) {
  try {
    const raw = await readFile(options.path ?? toolConfigPath(options), 'utf8')
    return normalizeToolConfig(JSON.parse(raw))
  } catch (error) {
    if (error?.code === 'ENOENT') return { webSearch: undefined }
    throw error
  }
}

export async function saveToolConfig(config, options: Record<string, any> = {}) {
  const path = options.path ?? toolConfigPath(options)
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(normalizeToolConfig(config), null, 2)}\n`)
  await rename(tempPath, path)
}

export function resolveWebSearchConfig(config) {
  const webSearch = config?.webSearch
  if (!webSearch?.provider) return undefined
  const apiKey = webSearch.apiKey || (webSearch.apiKeyEnv ? process.env[webSearch.apiKeyEnv] : undefined)
  return { ...webSearch, apiKey }
}

export async function fetchWebPage({ url, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_FETCH_BYTES }) {
  const target = await assertSafeUrl(url)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(target.href, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html, text/plain, application/xhtml+xml, application/json;q=0.8, */*;q=0.2',
        'user-agent': 'LannrCLI/1.0 webFetch',
      },
    })
    const contentType = response.headers.get('content-type') ?? ''
    const raw = await readLimitedResponse(response, maxBytes)
    return {
      url: target.href,
      finalUrl: response.url,
      status: response.status,
      ok: response.ok,
      contentType,
      title: extractTitle(raw, contentType),
      text: htmlToText(raw, contentType),
      bytes: Buffer.byteLength(raw),
      truncated: Buffer.byteLength(raw) >= maxBytes,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function searchWeb({ config, query, maxResults = 5, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const webSearch = resolveWebSearchConfig(config)
  if (!webSearch?.provider) throw new Error('webSearch is not configured. Run: lannr tools setup')
  if (!webSearch.apiKey) {
    throw new Error(`Missing ${webSearch.provider} API key. Run: lannr tools setup`)
  }
  const raw = webSearch.provider === 'exa'
    ? await searchExa({ query, maxResults, apiKey: webSearch.apiKey, timeoutMs })
    : webSearch.provider === 'tavily'
      ? await searchTavily({ query, maxResults, apiKey: webSearch.apiKey, timeoutMs })
      : (() => { throw new Error(`Unsupported webSearch provider: ${webSearch.provider}`) })()
  raw.results = await filterSafeResults(raw.results)
  return raw
}

async function filterSafeResults(results) {
  const { isSafeUrl } = await import('../safety/url-safety.js')
  const out = []
  for (const result of results) {
    if (!result.url) continue
    if (await isSafeUrl(result.url, undefined)) out.push(result)
  }
  return out
}

async function searchExa({ query, maxResults, apiKey, timeoutMs }) {
  const json = await postJson('https://api.exa.ai/search', {
    query,
    numResults: maxResults,
    contents: { text: { maxCharacters: 1000 } },
  }, {
    'x-api-key': apiKey,
  }, timeoutMs)
  return {
    provider: 'exa',
    query,
    results: (json.results ?? []).slice(0, maxResults).map((result) => ({
      title: result.title ?? '',
      url: result.url ?? '',
      snippet: result.text ?? result.summary ?? '',
      publishedDate: result.publishedDate ?? result.published_date ?? '',
      score: typeof result.score === 'number' ? result.score : undefined,
    })),
  }
}

async function searchTavily({ query, maxResults, apiKey, timeoutMs }) {
  const json = await postJson('https://api.tavily.com/search', {
    api_key: apiKey,
    query,
    max_results: maxResults,
    search_depth: 'basic',
    include_answer: false,
    include_raw_content: false,
  }, {}, timeoutMs)
  return {
    provider: 'tavily',
    query,
    results: (json.results ?? []).slice(0, maxResults).map((result) => ({
      title: result.title ?? '',
      url: result.url ?? '',
      snippet: result.content ?? result.snippet ?? '',
      publishedDate: result.published_date ?? result.publishedDate ?? '',
      score: typeof result.score === 'number' ? result.score : undefined,
    })),
  }
}

async function postJson(url, body, headers, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`)
    return JSON.parse(text)
  } finally {
    clearTimeout(timeout)
  }
}

async function readLimitedResponse(response, maxBytes) {
  const reader = response.body?.getReader()
  if (!reader) return response.text()
  const chunks = []
  let total = 0
  while (total < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    const remaining = maxBytes - total
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value
    chunks.push(Buffer.from(chunk))
    total += chunk.byteLength
  }
  await reader.cancel().catch(() => {})
  return Buffer.concat(chunks).toString('utf8')
}

function extractTitle(raw, contentType) {
  if (!contentType.includes('html')) return ''
  return decodeEntities(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim()
}

function htmlToText(raw, contentType) {
  if (!contentType.includes('html') && !looksLikeHtml(raw)) return raw.trim().slice(0, MAX_FETCH_BYTES)
  return decodeEntities(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function looksLikeHtml(value) {
  return /^\s*<!doctype html/i.test(value) || /^\s*<html[\s>]/i.test(value)
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function normalizeToolConfig(value) {
  const provider = normalizeProvider(value?.webSearch?.provider)
  return {
    webSearch: provider
      ? {
          provider,
          apiKey: stringOr(value.webSearch.apiKey, value.webSearch.api_key),
          apiKeyEnv: stringOr(value.webSearch.apiKeyEnv, value.webSearch.api_key_env),
        }
      : undefined,
  }
}

function normalizeProvider(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return ['exa', 'tavily'].includes(normalized) ? normalized : undefined
}

function stringOr(...values) {
  const value = values.find((item) => typeof item === 'string' && item.trim().length > 0)
  return value?.trim()
}
