import type { ConfidenceFlag, ConfidenceResult } from './types.js'

const penalties: Record<ConfidenceFlag, number> = {
  tool_error: 0.4,
  schema_coercion: 0.1,
  slow_execution: 0.05,
  unknown_tool: 0.15,
  empty_result: 0.2,
  router_fallback: 0.1,
}

export function scoreConfidence(flags: ConfidenceFlag[]): number {
  const total = [...new Set(flags)].reduce((sum, flag) => sum + penalties[flag], 0)
  return Math.max(0, Number((1 - total).toFixed(4)))
}

export function confidence(flags: ConfidenceFlag[]): ConfidenceResult {
  return { score: scoreConfidence(flags), flags: [...new Set(flags)] }
}
