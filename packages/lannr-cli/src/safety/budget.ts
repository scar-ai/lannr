// Iteration / token / cost budget tracking.
//
// Inspired by hermes' iteration_budget.py, usage_pricing.py, account_usage.py
// and rate_limit_tracker.py — collapsed into one small in-process meter.
//
// Pricing units: USD per 1M tokens. Cache reads usually 0.1x input, cache writes
// 1.25x input (Anthropic convention); table values reflect that where known.

const M = 1_000_000

// Order: longest prefix first so "claude-3-5-sonnet" beats "claude-3-5".
export const PRICING = [
  ['claude-opus-4', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['claude-sonnet-4', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['claude-haiku-4', { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  ['claude-3-5-sonnet', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  ['claude-3-opus', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['gpt-5', { input: 5, output: 15, cacheRead: 0.5 }],
  ['gpt-4.1', { input: 2, output: 8, cacheRead: 0.5 }],
  ['gpt-4o', { input: 2.5, output: 10, cacheRead: 1.25 }],
  ['gpt-4o-mini', { input: 0.15, output: 0.6, cacheRead: 0.075 }],
  ['o1', { input: 15, output: 60, cacheRead: 7.5 }],
  ['o3', { input: 2, output: 8, cacheRead: 0.5 }],
  ['gemini-2.5-pro', { input: 1.25, output: 5, cacheRead: 0.31 }],
  ['gemini-2.0-flash', { input: 0.1, output: 0.4, cacheRead: 0.025 }],
] as Array<[string, { input: number, output: number, cacheRead?: number, cacheWrite?: number }]>

export function priceFor(model) {
  if (!model) return null
  const key = String(model).toLowerCase()
  for (const [prefix, rates] of PRICING) {
    if (key.startsWith(prefix)) return rates
  }
  return null
}

export function costUsd(usage, model) {
  const rates = priceFor(model)
  if (!rates) return 0
  const input = (usage.inputTokens ?? 0) - (usage.cacheReadTokens ?? 0) - (usage.cacheWriteTokens ?? 0)
  const inCost = Math.max(0, input) * (rates.input ?? 0) / M
  const outCost = (usage.outputTokens ?? 0) * (rates.output ?? 0) / M
  const cacheReadCost = (usage.cacheReadTokens ?? 0) * (rates.cacheRead ?? rates.input ?? 0) / M
  const cacheWriteCost = (usage.cacheWriteTokens ?? 0) * (rates.cacheWrite ?? rates.input ?? 0) / M
  return inCost + outCost + cacheReadCost + cacheWriteCost
}

const ZERO = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })

export function createBudgetMeter({ maxTurns = Infinity, maxTokens = Infinity, maxCostUsd = Infinity, model = null }: Record<string, any> = {}) {
  const state = {
    turns: 0,
    usage: { ...ZERO },
    costUsd: 0,
    warned: { tokens: false, cost: false, turns: false },
    stopReason: null,
  }
  const warnAt = 0.85

  function recordUsage(usage: Record<string, any> = {}) {
    state.usage.inputTokens += +usage.inputTokens || 0
    state.usage.outputTokens += +usage.outputTokens || 0
    state.usage.cacheReadTokens += +usage.cacheReadTokens || 0
    state.usage.cacheWriteTokens += +usage.cacheWriteTokens || 0
    state.costUsd += costUsd(usage, model)
  }

  function recordTurn() { state.turns += 1 }

  function totalTokens() {
    return state.usage.inputTokens + state.usage.outputTokens
  }

  function check() {
    const events = []
    const total = totalTokens()
    if (Number.isFinite(maxTokens)) {
      if (!state.warned.tokens && total >= maxTokens * warnAt) {
        state.warned.tokens = true
        events.push({ level: 'warn', metric: 'tokens', value: total, limit: maxTokens })
      }
      if (total >= maxTokens) {
        state.stopReason = state.stopReason ?? { metric: 'tokens', value: total, limit: maxTokens }
      }
    }
    if (Number.isFinite(maxCostUsd)) {
      if (!state.warned.cost && state.costUsd >= maxCostUsd * warnAt) {
        state.warned.cost = true
        events.push({ level: 'warn', metric: 'costUsd', value: state.costUsd, limit: maxCostUsd })
      }
      if (state.costUsd >= maxCostUsd) {
        state.stopReason = state.stopReason ?? { metric: 'costUsd', value: state.costUsd, limit: maxCostUsd }
      }
    }
    if (Number.isFinite(maxTurns) && state.turns >= maxTurns) {
      state.stopReason = state.stopReason ?? { metric: 'turns', value: state.turns, limit: maxTurns }
    }
    return events
  }

  return {
    recordUsage,
    recordTurn,
    check,
    snapshot() {
      return {
        turns: state.turns,
        usage: { ...state.usage, totalTokens: totalTokens() },
        costUsd: round6(state.costUsd),
        model,
      }
    },
    shouldStop() { return state.stopReason },
    limits: { maxTurns, maxTokens, maxCostUsd },
  }
}

function round6(n) { return Math.round(n * 1_000_000) / 1_000_000 }
