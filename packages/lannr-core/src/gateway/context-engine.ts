// Context engine: decide when to compact the running message history and how.
//
// Strategy (after hermes' context_compressor + openclaw's context-engine):
//   1. Estimate tokens for the current message list.
//   2. If under softBudget → keep everything.
//   3. If over softBudget → run the cheap synchronous compressor
//      (`compressTrajectory`) which protects head + tail and elides the middle.
//   4. If over hardBudget AND a model summarizer was provided, ask the model
//      for a structured summary of the middle and replace the elided span with
//      that summary instead of the heuristic placeholder.
//
// The engine is provider-agnostic: callers pass a `summarize(messages)` fn
// (gateway wires this to a cheap completion against the agent's provider).

import { partsToPlainText } from './image-input.js'
import { compressTrajectory, totalChars } from './trajectory.js'

const CHARS_PER_TOKEN = 4
const DEFAULT_SOFT_TOKENS = 60_000   // start trimming around here
const DEFAULT_HARD_TOKENS = 100_000  // model-summarize past here
const PROTECT_FIRST = 2
const PROTECT_LAST = 6

export function estimateTokens(messages) {
  return Math.ceil(totalChars(messages) / CHARS_PER_TOKEN)
}

export function createContextEngine({
  softBudgetTokens = DEFAULT_SOFT_TOKENS,
  hardBudgetTokens = DEFAULT_HARD_TOKENS,
  summarize = null,
} = {}) {
  const softChars = softBudgetTokens * CHARS_PER_TOKEN
  const hardChars = hardBudgetTokens * CHARS_PER_TOKEN

  // Async generator so the gateway can stream `lannr:compaction:start` /
  // `lannr:compaction` events to the UI while the model summarization runs.
  // The final yielded event is `lannr:compaction:result` carrying the rewritten
  // message list (the caller pulls it out and discards the wrapper).
  async function* compactStream(messages, options: { force?: boolean } = {}) {
    const { force = false } = options
    if (!Array.isArray(messages) || messages.length <= PROTECT_FIRST + PROTECT_LAST) {
      yield { type: 'lannr:compaction:result', messages, skipped: 'too-short' }
      return
    }
    const chars = totalChars(messages)
    if (!force && chars <= softChars) {
      yield { type: 'lannr:compaction:result', messages }
      return
    }

    const beforeTokens = Math.ceil(chars / CHARS_PER_TOKEN)
    // `force` (set by the user-triggered /compact path) bypasses the soft/hard
    // thresholds and always runs the model summarizer when one is available.
    const willUseModel = (force || chars > hardChars) && typeof summarize === 'function'
    const budgetTokens = willUseModel ? hardBudgetTokens : softBudgetTokens

    yield {
      type: 'lannr:compaction:start',
      mode: willUseModel ? 'model' : 'heuristic',
      beforeTokens,
      budgetTokens,
      forced: Boolean(force),
    }

    const heuristic = compressTrajectory(messages, { charBudget: softChars })

    if (!willUseModel) {
      yield {
        type: 'lannr:compaction',
        mode: chars <= hardChars ? 'heuristic' : 'heuristic-no-model',
        beforeTokens,
        afterTokens: estimateTokens(heuristic),
        budgetTokens: softBudgetTokens,
      }
      yield { type: 'lannr:compaction:result', messages: heuristic }
      return
    }

    const head = messages.slice(0, PROTECT_FIRST)
    const tail = messages.slice(-PROTECT_LAST)
    const middle = messages.slice(PROTECT_FIRST, messages.length - PROTECT_LAST)
    if (middle.length === 0) {
      yield {
        type: 'lannr:compaction', mode: 'heuristic', beforeTokens,
        afterTokens: estimateTokens(heuristic), budgetTokens: hardBudgetTokens,
      }
      yield { type: 'lannr:compaction:result', messages: heuristic }
      return
    }

    let summaryText
    try {
      summaryText = await summarize(middle)
    } catch (err) {
      yield {
        type: 'lannr:compaction', mode: 'heuristic-fallback', beforeTokens,
        afterTokens: estimateTokens(heuristic), budgetTokens: hardBudgetTokens,
        error: err?.message ?? String(err),
      }
      yield { type: 'lannr:compaction:result', messages: heuristic }
      return
    }

    const summarized = [
      ...head,
      { role: 'user', content: buildSummaryEnvelope(summaryText, middle.length) },
      ...tail,
    ]

    yield {
      type: 'lannr:compaction', mode: 'model', beforeTokens,
      afterTokens: estimateTokens(summarized), budgetTokens: hardBudgetTokens,
      summarizedMessages: middle.length,
    }
    yield { type: 'lannr:compaction:result', messages: summarized }
  }

  return { compactStream, softBudgetTokens, hardBudgetTokens }
}

function buildSummaryEnvelope(summary, dropped) {
  return [
    `[Context compacted: ${dropped} earlier turns replaced with a model-generated summary to stay under the context budget.]`,
    '',
    'SUMMARY OF ELIDED TURNS:',
    String(summary ?? '').trim(),
    '',
    'Continue from the recent turns below; the head (system + first user message) and the last few turns are preserved verbatim.',
  ].join('\n')
}

// Build the prompt the summarizer should send. Plain-text, model-agnostic.
export function summarizationPrompt(messages) {
  const transcript = messages.map((m) => {
    const role = (m.role ?? 'user').toUpperCase()
    const content = partsToPlainText(m?.content).replace(/\s+/g, ' ').slice(0, 6_000)
    return `[${role}]\n${content}`
  }).join('\n\n')
  return [
    'You are compressing a long agent transcript. Summarize the conversation below so the agent can continue without losing critical context.',
    '',
    'Required sections (use these exact headers):',
    '## Goal',
    '## Key decisions',
    '## Files touched',
    '## Open questions',
    '## Last state',
    '',
    'Be specific: keep file paths, function names, exact errors, command results. Omit pleasantries, intermediate reasoning, and redundant tool output.',
    '',
    '--- TRANSCRIPT ---',
    transcript,
  ].join('\n')
}
