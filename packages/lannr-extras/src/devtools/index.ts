import type { LannrEvent } from 'lannr-core'

export class ExecutionTimeline {
  readonly events: LannrEvent[] = []
  push(event: LannrEvent): void {
    this.events.push(event)
  }
  byType<T extends LannrEvent['type']>(type: T): Array<Extract<LannrEvent, { type: T }>> {
    return this.events.filter((event): event is Extract<LannrEvent, { type: T }> => event.type === type)
  }
  summary(): ExecutionSummary {
    const toolCalls = this.byType('lannr:tool:call').length
    const toolErrors = this.byType('lannr:tool:error').length
    const close = this.byType('lannr:vault:close').at(-1)
    const confidence = this.byType('lannr:confidence').at(-1)
    return {
      eventCount: this.events.length,
      toolCalls,
      toolErrors,
      durationMs: close?.durationMs ?? 0,
      confidence: confidence?.score ?? null,
      flags: confidence?.flags ?? [],
    }
  }
  toJSON(): LannrEvent[] {
    return this.events
  }
}

export interface ExecutionSummary {
  eventCount: number
  toolCalls: number
  toolErrors: number
  durationMs: number
  confidence: number | null
  flags: string[]
}

export class MemoryBrowser<T extends { id: string; name: string; tags: string[]; trust: unknown }> {
  constructor(private routines: T[]) {}
  search(query: string): T[] {
    const normalized = query.toLowerCase()
    return this.routines.filter((routine) => routine.name.toLowerCase().includes(normalized) || routine.tags.some((tag) => tag.toLowerCase().includes(normalized)))
  }
  byTrust(level: string): T[] {
    return this.routines.filter((routine) => typeof routine.trust === 'object' && routine.trust !== null && 'level' in routine.trust && routine.trust.level === level)
  }
  toJSON(): T[] {
    return this.routines
  }
}
