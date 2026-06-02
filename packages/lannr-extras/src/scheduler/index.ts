import type { Lannr } from 'lannr-core'

export interface ReactiveRoutine {
  id: string
  routineId: string
  name: string
  trigger: RoutineTrigger
  input: unknown
  inputMapper?: string
  sink: RoutineSink
  enabled: boolean
  lastRunAt: Date | null
  lastRunStatus: 'success' | 'failure' | 'skipped' | null
  consecutiveFailures: number
  failureThreshold: number
  nextRunAt: Date | null
  catchUp: boolean
  runningSince?: Date | null
  runningPid?: number | null
  createdAt: Date
}

export type RoutineTrigger = { type: 'cron'; cron: string } | { type: 'once'; runAt: string } | { type: 'interval'; intervalMs: number } | { type: 'event'; event: string } | { type: 'webhook'; secret: string }
export type RoutineSink = { type: 'slack'; channel: string; webhookUrl: string } | { type: 'webhook'; url: string; headers?: Record<string, string> } | { type: 'email'; to: string; endpoint?: string; headers?: Record<string, string> } | { type: 'store' }
export type EventHandler = (payload: unknown) => void | Promise<void>
export type Unsubscribe = () => void
export type ReactiveRoutineStatus = 'scheduled' | 'due' | 'running' | 'stale' | 'completed' | 'disabled'

const STALE_RUNNING_MS = 30 * 60 * 1000

export interface LannrEventBus {
  publish(event: string, payload: unknown): Promise<void>
  subscribe(event: string, handler: EventHandler): Unsubscribe
}

export interface ReactiveRoutineStore {
  save(routine: ReactiveRoutine): Promise<void>
  get(id: string): Promise<ReactiveRoutine | null>
  list(): Promise<ReactiveRoutine[]>
  getDue(now: Date): Promise<ReactiveRoutine[]>
  markRunning?(id: string, options?: { pid?: number }): Promise<void>
  recordSuccess(id: string, result: unknown): Promise<void>
  recordFailure(id: string, error: unknown): Promise<ReactiveRoutine>
  disable(id: string, reason: string): Promise<void>
  enable(id: string): Promise<void>
}

export class InProcessEventBus implements LannrEventBus {
  private handlers = new Map<string, Set<EventHandler>>()

  async publish(event: string, payload: unknown): Promise<void> {
    await Promise.all([...(this.handlers.get(event) ?? [])].map((handler) => handler(payload)))
  }

  subscribe(event: string, handler: EventHandler): Unsubscribe {
    const handlers = this.handlers.get(event) ?? new Set<EventHandler>()
    handlers.add(handler)
    this.handlers.set(event, handlers)
    return () => handlers.delete(handler)
  }
}

export const RedisEventBus = InProcessEventBus

export class MemoryReactiveRoutineStore implements ReactiveRoutineStore {
  private routines = new Map<string, ReactiveRoutine>()
  private results = new Map<string, unknown[]>()

  async save(routine: ReactiveRoutine): Promise<void> {
    this.routines.set(routine.id, routine)
  }

  async get(id: string): Promise<ReactiveRoutine | null> {
    return this.routines.get(id) ?? null
  }

  async list(): Promise<ReactiveRoutine[]> {
    return [...this.routines.values()]
  }

  async getDue(now: Date): Promise<ReactiveRoutine[]> {
    return [...this.routines.values()].filter((routine) => isTimeTriggered(routine) && routine.enabled && routine.nextRunAt && routine.nextRunAt <= now && !isActivelyRunning(routine, now))
  }

  async markRunning(id: string, { pid }: { pid?: number } = {}): Promise<void> {
    const routine = await requireRoutine(this, id)
    this.routines.set(id, { ...routine, runningSince: new Date(), runningPid: pid ?? process.pid })
  }

  async recordSuccess(id: string, result: unknown): Promise<void> {
    const routine = await requireRoutine(this, id)
    const nextRunAt = computeNextRunAt({ ...routine, lastRunStatus: 'success' }, new Date())
    const enabled = routine.trigger.type === 'once' ? false : routine.enabled
    this.routines.set(id, { ...routine, enabled, lastRunAt: new Date(), lastRunStatus: 'success', consecutiveFailures: 0, nextRunAt, runningSince: null, runningPid: null })
    this.results.set(id, [...(this.results.get(id) ?? []), result])
  }

  async recordFailure(id: string): Promise<ReactiveRoutine> {
    const routine = await requireRoutine(this, id)
    const consecutiveFailures = routine.consecutiveFailures + 1
    const delayMs = Math.min(300, 2 ** routine.consecutiveFailures * 30) * 1000
    const nextRunAt = routine.trigger.type === 'cron' || routine.trigger.type === 'interval' ? new Date(Date.now() + delayMs) : routine.nextRunAt
    const next = { ...routine, lastRunAt: new Date(), lastRunStatus: 'failure' as const, consecutiveFailures, nextRunAt, runningSince: null, runningPid: null }
    this.routines.set(id, next)
    return next
  }

  async disable(id: string): Promise<void> {
    const routine = await requireRoutine(this, id)
    this.routines.set(id, { ...routine, enabled: false })
  }

  async enable(id: string): Promise<void> {
    const routine = await requireRoutine(this, id)
    this.routines.set(id, { ...routine, enabled: true, consecutiveFailures: 0, nextRunAt: computeNextRunAt(routine, new Date()) })
  }
}

export class LannrScheduler {
  private running = false
  private locks = new Set<string>()
  private unsubscribes: Unsubscribe[] = []

  constructor(private lannr: Lannr, private store: ReactiveRoutineStore, private events: LannrEventBus = new InProcessEventBus(), private pollMs = 10_000) {}

  async start(): Promise<void> {
    this.running = true
    await this.subscribeToEvents()
    while (this.running) {
      const due = await this.store.getDue(new Date())
      await Promise.allSettled(due.map((routine) => this.execute(routine)))
      await sleep(this.pollMs)
    }
  }

  stop(): void {
    this.running = false
    this.unsubscribes.forEach((unsubscribe) => unsubscribe())
    this.unsubscribes = []
  }

  async runNow(id: string, payload?: unknown): Promise<unknown> {
    const routine = await requireRoutine(this.store, id)
    return this.execute(routine, payload)
  }

  async handleWebhook(name: string, payload: unknown, secret: string): Promise<unknown> {
    const routine = await requireRoutine(this.store, name)
    if (routine.trigger.type !== 'webhook') throw new Error(`ReactiveRoutine ${name} is not a webhook routine`)
    if (routine.trigger.secret !== secret) throw new Error('Invalid webhook secret')
    return this.execute(routine, payload)
  }

  private async subscribeToEvents(): Promise<void> {
    for (const routine of await this.store.list()) {
      if (routine.trigger.type !== 'event') continue
      this.unsubscribes.push(this.events.subscribe(routine.trigger.event, async (payload) => { await this.execute(routine, payload) }))
    }
  }

  private async execute(reactive: ReactiveRoutine, payload?: unknown): Promise<unknown> {
    if (this.locks.has(reactive.id) || !reactive.enabled) return undefined
    this.locks.add(reactive.id)
    try {
      await this.store.markRunning?.(reactive.id)
      const routine = await this.lannr.memory?.get(reactive.routineId)
      if (!routine) {
        await this.store.disable(reactive.id, 'routine-not-found')
        return undefined
      }
      const input = reactive.inputMapper && payload !== undefined ? evaluateInputMapper(reactive.inputMapper, payload) : reactive.input
      const result = await this.lannr.runRoutine(routine, input)
      await this.store.recordSuccess(reactive.id, result)
      await dispatchToSink(reactive.sink, result)
      return result
    } catch (error) {
      const next = await this.store.recordFailure(reactive.id, error)
      if (next.consecutiveFailures === 3) await this.events.publish('lannr:reactive:degraded', { routine: next, error: String(error) })
      if (next.consecutiveFailures >= next.failureThreshold) {
        await this.store.disable(reactive.id, 'consecutive-failures')
        await this.events.publish('lannr:reactive:disabled', { routine: next, error: String(error) })
      }
      throw error
    } finally {
      this.locks.delete(reactive.id)
    }
  }
}

export function schedule(name: string, config: { cron: string; routine: string; input: unknown; sink?: RoutineSink; catchUp?: boolean; failureThreshold?: number }): ReactiveRoutine {
  return createReactive(name, { type: 'cron', cron: config.cron }, config.routine, config.input, undefined, config.sink, config.catchUp, config.failureThreshold)
}

export function once(name: string, config: { runAt: Date | string; routine: string; input: unknown; sink?: RoutineSink; catchUp?: boolean; failureThreshold?: number }): ReactiveRoutine {
  const runAt = config.runAt instanceof Date ? config.runAt : new Date(config.runAt)
  if (Number.isNaN(runAt.getTime())) throw new Error(`Invalid runAt for schedule: ${config.runAt}`)
  return createReactive(name, { type: 'once', runAt: runAt.toISOString() }, config.routine, config.input, undefined, config.sink, config.catchUp, config.failureThreshold)
}

export function interval(name: string, config: { intervalMs: number; routine: string; input: unknown; sink?: RoutineSink; catchUp?: boolean; failureThreshold?: number }): ReactiveRoutine {
  if (!Number.isFinite(config.intervalMs) || config.intervalMs <= 0) throw new Error(`Invalid intervalMs for schedule: ${config.intervalMs}`)
  return createReactive(name, { type: 'interval', intervalMs: config.intervalMs }, config.routine, config.input, undefined, config.sink, config.catchUp, config.failureThreshold)
}

export function on(name: string, config: { event: string; routine: string; inputMapper: string; sink?: RoutineSink; failureThreshold?: number }): ReactiveRoutine {
  validateInputMapper(config.inputMapper)
  return createReactive(name, { type: 'event', event: config.event }, config.routine, undefined, config.inputMapper, config.sink, false, config.failureThreshold)
}

export function onWebhook(name: string, config: { routine: string; inputMapper: string; secret: string; sink?: RoutineSink; failureThreshold?: number }): ReactiveRoutine & { webhookUrl: string } {
  validateInputMapper(config.inputMapper)
  return { ...createReactive(name, { type: 'webhook', secret: config.secret }, config.routine, undefined, config.inputMapper, config.sink, false, config.failureThreshold), webhookUrl: `/lannr/webhooks/${name}` }
}

export function getNextRun(cronExpression: string, after: Date = new Date()): Date {
  for (let offsetMinutes = 1; offsetMinutes <= 366 * 24 * 60; offsetMinutes++) {
    const next = new Date(after.getTime() + offsetMinutes * 60_000)
    next.setSeconds(0, 0)
    if (matchesCron(cronExpression, next)) return next
  }
  throw new Error(`No future run found for cron expression: ${cronExpression}`)
}

export function evaluateInputMapper(mapper: string, event: unknown): unknown {
  validateInputMapper(mapper)
  return Function('event', `"use strict"; return (${mapper})(event)`).call(undefined, event)
}

export function getRoutineStatus(routine: ReactiveRoutine, now: Date = new Date()): ReactiveRoutineStatus {
  if (routine.runningSince) return isActivelyRunning(routine, now) ? 'running' : 'stale'
  if (!routine.enabled) return routine.trigger.type === 'once' && routine.lastRunStatus === 'success' ? 'completed' : 'disabled'
  const nextMs = routine.nextRunAt instanceof Date ? routine.nextRunAt.getTime() : routine.nextRunAt ? new Date(routine.nextRunAt).getTime() : null
  if (nextMs != null && nextMs <= now.getTime()) return 'due'
  return 'scheduled'
}

function validateInputMapper(mapper: string): void {
  if (/\b(import|require|async|await|process|globalThis|global|window|fetch)\b/.test(mapper)) throw new Error('inputMapper must be a pure synchronous function with no imports or external references')
  Function('event', `"use strict"; return (${mapper})(event)`)
}

function createReactive(name: string, trigger: RoutineTrigger, routine: string, input: unknown, inputMapper?: string, sink: RoutineSink = { type: 'store' }, catchUp = false, failureThreshold = 5): ReactiveRoutine {
  return { id: name, name, routineId: routine, trigger, input, inputMapper, sink, enabled: true, lastRunAt: null, lastRunStatus: null, consecutiveFailures: 0, failureThreshold, nextRunAt: computeNextRunAt({ trigger } as ReactiveRoutine), catchUp, runningSince: null, runningPid: null, createdAt: new Date() }
}

function isTimeTriggered(routine: ReactiveRoutine): boolean {
  return routine.trigger.type === 'cron' || routine.trigger.type === 'once' || routine.trigger.type === 'interval'
}

function isActivelyRunning(routine: ReactiveRoutine, now: Date): boolean {
  if (!routine.runningSince) return false
  const startedMs = routine.runningSince instanceof Date ? routine.runningSince.getTime() : new Date(routine.runningSince).getTime()
  return Number.isFinite(startedMs) && now.getTime() - startedMs <= STALE_RUNNING_MS
}

function computeNextRunAt(routine: ReactiveRoutine, now: Date = new Date()): Date | null {
  if (routine.trigger.type === 'cron') return getNextRun(routine.trigger.cron, now)
  if (routine.trigger.type === 'interval') return new Date(now.getTime() + routine.trigger.intervalMs)
  if (routine.trigger.type === 'once') return routine.lastRunStatus === 'success' ? null : new Date(routine.trigger.runAt)
  return null
}

async function dispatchToSink(sink: RoutineSink, result: unknown): Promise<void> {
  if (sink.type === 'store') return
  if (sink.type === 'webhook') await fetch(sink.url, { method: 'POST', headers: { 'content-type': 'application/json', ...sink.headers }, body: JSON.stringify(result) })
  if (sink.type === 'slack') await fetch(sink.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: sink.channel, text: JSON.stringify(result) }) })
  if (sink.type === 'email') {
    if (!sink.endpoint) throw new Error('Email sink requires an endpoint')
    await fetch(sink.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...sink.headers }, body: JSON.stringify({ to: sink.to, result }) })
  }
}

async function requireRoutine(store: ReactiveRoutineStore, id: string): Promise<ReactiveRoutine> {
  const routine = await store.get(id)
  if (!routine) throw new Error(`ReactiveRoutine not found: ${id}`)
  return routine
}

function parseField(field: string, current: number, min: number, max: number): number {
  if (field === '*') return current
  const value = Number(field)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Unsupported cron field: ${field}`)
  return value
}

function matchesCron(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`Unsupported cron expression: ${expression}`)
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  return matchesField(minute, date.getMinutes(), 0, 59)
    && matchesField(hour, date.getHours(), 0, 23)
    && matchesField(dayOfMonth, date.getDate(), 1, 31)
    && matchesField(month, date.getMonth() + 1, 1, 12)
    && matchesField(dayOfWeek, date.getDay(), 0, 7, date.getDay() === 0 ? 7 : date.getDay())
}

function matchesField(field: string, value: number, min: number, max: number, altValue = value): boolean {
  return field.split(',').some((part) => matchesFieldPart(part, value, min, max, altValue))
}

function matchesFieldPart(part: string, value: number, min: number, max: number, altValue: number): boolean {
  const [rangePart, stepPart] = part.split('/')
  const step = stepPart ? Number(stepPart) : 1
  if (!Number.isInteger(step) || step <= 0) throw new Error(`Unsupported cron step: ${part}`)
  let start = min
  let end = max
  if (rangePart !== '*') {
    if (rangePart.includes('-')) {
      const [rawStart, rawEnd] = rangePart.split('-').map(Number)
      start = rawStart
      end = rawEnd
    } else {
      start = Number(rangePart)
      end = start
    }
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) throw new Error(`Unsupported cron field: ${part}`)
  return (value >= start && value <= end && (value - start) % step === 0) || (altValue >= start && altValue <= end && (altValue - start) % step === 0)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
