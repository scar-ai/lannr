export interface PromptCacheKeyOptions {
  namespace?: string | null
  threadId?: string | null
  sessionId?: string | null
  conversationId?: string | null
  agentId?: string | null
}

export function buildPromptCacheKey(options: PromptCacheKeyOptions = {}): string | undefined {
  const stableId = firstNonEmpty(options.threadId, options.sessionId, options.conversationId)
  if (!stableId) return undefined
  const namespace = cleanSegment(options.namespace) ?? 'lannr'
  const agentId = cleanSegment(options.agentId)
  return [namespace, agentId, stableId].filter(Boolean).join(':')
}

export function resolvePromptCacheKey(...keys: Array<string | null | undefined>): string | undefined {
  return firstNonEmpty(...keys)
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function cleanSegment(value: string | null | undefined): string | undefined {
  const trimmed = firstNonEmpty(value)
  return trimmed?.replace(/\s+/g, '-')
}
