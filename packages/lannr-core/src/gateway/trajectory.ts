// Runtime trajectory compression: keep long agent loops under a token budget
// by summarizing the middle of the conversation and pruning bulky tool blobs.
//
// Inspired by hermes' offline trajectory_compressor.py and openclaw's
// trim-history pattern. Runs in-loop, before each model call.

import { contentCharLength, partsToPlainText } from './image-input.js'

const DEFAULT_CHAR_BUDGET = 320_000
// Approximate 4 chars per token; conservative for safety.
const CHARS_PER_TOKEN = 4
const PROTECT_FIRST = 2       // system + first user
const PROTECT_LAST = 6        // recent turns
const TOOL_BLOB_TRIM = 1_500  // shrink tool outputs in compressed region

export function estimateTokens(messages) {
  let chars = 0
  for (const message of messages) chars += contentCharLength(message?.content)
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

export function totalChars(messages) {
  let chars = 0
  for (const message of messages) chars += contentCharLength(message?.content)
  return chars
}

// Synchronous, dependency-free compression. Always safe to call; only
// rewrites when the budget is exceeded. Strategy:
//   1. Protect the first PROTECT_FIRST messages and last PROTECT_LAST.
//   2. From the middle, drop messages oldest-first, replacing the dropped
//      span with a single synthetic 'user' summary message.
//   3. Within the dropped span, large tool/assistant blobs are first truncated
//      so we can keep more turns intact when possible.
export function compressTrajectory(messages, options: { charBudget?: number } = {}) {
  const budget = options.charBudget ?? DEFAULT_CHAR_BUDGET
  if (!Array.isArray(messages) || messages.length === 0) return messages
  if (totalChars(messages) <= budget) return messages

  const head = messages.slice(0, PROTECT_FIRST)
  const tail = messages.slice(-PROTECT_LAST)
  const middle = messages.slice(PROTECT_FIRST, messages.length - PROTECT_LAST)
  if (middle.length === 0) return messages

  // Pass 1: trim bulky middle blobs in place. Multipart content (e.g. messages
  // carrying image attachments) is left alone so we don't mangle non-text parts.
  const trimmedMiddle = middle.map((message) => {
    if (typeof message?.content !== 'string') return message
    const content = message.content
    if (content.length <= TOOL_BLOB_TRIM) return message
    if (message.role === 'system') return message
    return {
      ...message,
      content: `${content.slice(0, TOOL_BLOB_TRIM)}\n…[trimmed ${content.length - TOOL_BLOB_TRIM} chars from older turn]…`,
    }
  })

  let working = [...head, ...trimmedMiddle, ...tail]
  if (totalChars(working) <= budget) return working

  // Pass 2: drop oldest middle messages, accumulating a summary.
  const dropped = []
  while (totalChars(working) > budget && trimmedMiddle.length > 0) {
    dropped.push(trimmedMiddle.shift())
    working = [...head, ...trimmedMiddle, ...tail]
  }

  if (dropped.length === 0) return working

  const summary = {
    role: 'user',
    content: buildSummary(dropped),
  }
  return [...head, summary, ...trimmedMiddle, ...tail]
}

function buildSummary(dropped) {
  const counts = {}
  const highlights = []
  for (const message of dropped) {
    counts[message.role] = (counts[message.role] ?? 0) + 1
    const content = partsToPlainText(message?.content).replace(/\s+/g, ' ').trim()
    if (!content) continue
    if (message.role === 'user') {
      highlights.push(`USER: ${content.slice(0, 140)}`)
    } else if (message.role === 'assistant') {
      highlights.push(`ASSISTANT: ${content.slice(0, 140)}`)
    }
  }
  const lastHighlights = highlights.slice(-8)
  const breakdown = Object.entries(counts).map(([role, n]) => `${n} ${role}`).join(', ')
  return [
    `[Context compressed: ${dropped.length} earlier turns elided (${breakdown}) to fit context budget.]`,
    'Older content removed; the agent goal, system prompt, and recent turns are preserved below.',
    lastHighlights.length ? `Recent highlights from elided span:\n${lastHighlights.map((line) => `- ${line}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
}
