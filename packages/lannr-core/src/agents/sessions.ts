import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const LAST_SESSION_FILE = '_last-session.json'

export function generateSessionId() {
  return `sess-${randomUUID().slice(0, 8)}`
}

export function normalizeSessionId(value) {
  const id = String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return id || generateSessionId()
}

export function sessionPath(agent, sessionId) {
  return join(agent.sessionsDir, `${normalizeSessionId(sessionId)}.json`)
}

export function lastSessionPath(agent) {
  return join(agent.sessionsDir, LAST_SESSION_FILE)
}

export async function loadLastSessionId(agent) {
  try {
    const raw = await readFile(lastSessionPath(agent), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed?.sessionId === 'string' && parsed.sessionId.trim() ? normalizeSessionId(parsed.sessionId) : null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function saveLastSessionId(agent, sessionId) {
  await mkdir(agent.sessionsDir, { recursive: true })
  const payload = {
    sessionId: normalizeSessionId(sessionId),
    updatedAt: new Date().toISOString(),
  }
  await writeJsonAtomic(lastSessionPath(agent), payload)
  return payload.sessionId
}

export async function listSessions(agent) {
  let entries
  try {
    entries = await readdir(agent.sessionsDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const files = entries.filter((name) => name.endsWith('.json') && name !== LAST_SESSION_FILE)
  const results = await Promise.all(files.map(async (file) => {
    try {
      const raw = await readFile(join(agent.sessionsDir, file), 'utf8')
      const parsed = JSON.parse(raw)
      const id = normalizeSessionId(parsed?.id ?? file.replace(/\.json$/, ''))
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : []
      const title = deriveSessionTitle(messages)
      const updatedAt = parsed?.updatedAt ?? parsed?.createdAt ?? null
      return { id, title, updatedAt, messageCount: messages.length }
    } catch {
      return null
    }
  }))
  return results
    .filter(Boolean)
    .sort((a, b) => {
      const at = a.updatedAt ? Date.parse(a.updatedAt) : 0
      const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0
      return bt - at
    })
}

function deriveSessionTitle(messages) {
  for (const msg of messages) {
    if (msg?.role !== 'user') continue
    const text = extractMessageText(msg.content)
    if (text) {
      const trimmed = text.trim().replace(/\s+/g, ' ')
      if (trimmed) return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed
    }
  }
  return '(no messages)'
}

function extractMessageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') parts.push(part)
    else if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join(' ')
}

export async function loadSession(agent, sessionId) {
  try {
    const raw = await readFile(sessionPath(agent, sessionId), 'utf8')
    return normalizeSession(JSON.parse(raw), agent, sessionId)
  } catch (error) {
    if (error?.code === 'ENOENT') return createEmptySession(agent, sessionId)
    throw error
  }
}

export async function saveSession(agent, session) {
  await mkdir(agent.sessionsDir, { recursive: true })
  await writeJsonAtomic(sessionPath(agent, session.id), session)
}

export async function appendSessionTurn(agent, sessionId, turn) {
  const session = await loadSession(agent, sessionId)
  const now = new Date().toISOString()
  const normalizedTurn = normalizeTurn(turn, session.turns.length + 1, now)
  session.agentId = agent.id
  session.updatedAt = now
  // Remember the model/provider this turn actually ran on so the session
  // resumes on the same model the user last used.
  const turnModel = turn?.runtime?.model ?? turn?.request?.model ?? null
  const turnProvider = turn?.runtime?.providerId ?? turn?.request?.provider ?? null
  if (turnModel) session.model = turnModel
  if (turnProvider) session.provider = turnProvider
  session.messages = mergeSessionMessages(session.messages, normalizedTurn.messages)
  normalizedTurn.messages = session.messages
  session.turns.push(normalizedTurn)
  session.usage = addUsage(session.usage, normalizedTurn.usage)
  // Last request's window occupancy (not summed) — overwrite each turn.
  if (turn?.lastUsage) session.lastUsage = normalizeUsage(turn.lastUsage)
  await saveSession(agent, session)
  await saveLastSessionId(agent, session.id)
  return session
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

function mergeSessionMessages(existing, next) {
  if (startsWithMessages(next, existing)) return next
  return [...existing, ...next]
}

function startsWithMessages(messages, prefix) {
  if (prefix.length > messages.length) return false
  return prefix.every((message, index) => (
    messages[index]?.role === message.role && contentEqual(messages[index]?.content, message.content)
  ))
}

function contentEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (typeof a === 'string') return a === b
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((part, i) => JSON.stringify(part) === JSON.stringify(b[i]))
  }
  return false
}

function createEmptySession(agent, sessionId) {
  const now = new Date().toISOString()
  return {
    version: 1,
    id: normalizeSessionId(sessionId),
    agentId: agent.id,
    createdAt: now,
    updatedAt: now,
    model: null,
    provider: null,
    messages: [],
    usage: zeroUsage(),
    lastUsage: null,
    turns: [],
  }
}

function normalizeSession(value, agent, sessionId) {
  return {
    version: 1,
    id: normalizeSessionId(value?.id ?? sessionId),
    agentId: value?.agentId ?? agent.id,
    createdAt: value?.createdAt ?? new Date().toISOString(),
    updatedAt: value?.updatedAt ?? value?.createdAt ?? new Date().toISOString(),
    model: typeof value?.model === 'string' ? value.model : null,
    provider: typeof value?.provider === 'string' ? value.provider : null,
    messages: Array.isArray(value?.messages) ? value.messages.map(normalizeMessage).filter(Boolean) : [],
    usage: normalizeUsage(value?.usage),
    lastUsage: value?.lastUsage ? normalizeUsage(value.lastUsage) : null,
    turns: Array.isArray(value?.turns) ? value.turns : [],
  }
}

function normalizeTurn(turn, index, now) {
  const usage = normalizeUsage(turn?.usage)
  return {
    id: turn?.id ?? `turn-${index}`,
    index,
    startedAt: turn?.startedAt ?? now,
    endedAt: turn?.endedAt ?? now,
    runtime: turn?.runtime ?? null,
    request: turn?.request ?? null,
    messages: Array.isArray(turn?.messages) ? turn.messages.map(normalizeMessage).filter(Boolean) : [],
    events: Array.isArray(turn?.events) ? turn.events : [],
    final: turn?.final ?? null,
    usage,
  }
}

export function mergeAssistantMessage(messages, answer) {
  const normalized = Array.isArray(messages) ? messages.map(normalizeMessage).filter(Boolean) : []
  const text = typeof answer === 'string' ? answer : ''
  if (!text.trim()) return normalized
  const last = normalized[normalized.length - 1]
  if (last?.role === 'assistant' && typeof last.content === 'string' && last.content === text) return normalized
  return [...normalized, { role: 'assistant', content: text }]
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object') return null
  const role = ['system', 'user', 'assistant', 'tool'].includes(message.role) ? message.role : 'user'
  return { role, content: normalizeContent(message.content) }
}

function normalizeContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content.map(normalizeContentPart).filter(Boolean)
    if (parts.length === 0) return ''
    if (parts.length === 1 && parts[0].type === 'text') return parts[0].text
    return parts
  }
  if (content == null) return ''
  return String(content)
}

function normalizeContentPart(part) {
  if (typeof part === 'string') return part ? { type: 'text', text: part } : null
  if (!part || typeof part !== 'object') return null
  if (part.type === 'image') {
    if (!part.data || !part.mediaType) return null
    return {
      type: 'image',
      mediaType: String(part.mediaType),
      data: String(part.data),
      source: part.source ? String(part.source) : null,
      filename: part.filename ? String(part.filename) : null,
    }
  }
  if (part.type === 'text' || typeof part.text === 'string') {
    return { type: 'text', text: String(part.text ?? '') }
  }
  return null
}

export function addUsage(left, right) {
  const a = normalizeUsage(left)
  const b = normalizeUsage(right)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  }
}

export function zeroUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function normalizeUsage(value) {
  const inputTokens = number(value?.inputTokens)
  const outputTokens = number(value?.outputTokens)
  return {
    inputTokens,
    outputTokens,
    totalTokens: number(value?.totalTokens) || inputTokens + outputTokens,
    cacheReadTokens: number(value?.cacheReadTokens),
    cacheWriteTokens: number(value?.cacheWriteTokens),
  }
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0
}
