import { timingSafeEqual } from 'node:crypto'
import { evaluateInputMapper, InProcessEventBus } from 'lannr-extras/scheduler'
import { createAgentRuntime, runAgentPrompt } from '../agents/runtime.js'
import { createAgentReactiveRoutineStore } from './store.js'

const DEFAULT_POLL_MS = 10_000

export async function executeScheduledAction(runtime, reactive, payload) {
  if (reactive.agentTurn) {
    const completion = await runAgentPrompt({
      agentId: reactive.agentTurn.agentId ?? runtime.agent.id,
      prompt: reactive.agentTurn.prompt,
      session: reactive.agentTurn.session ?? null,
      stream: false,
    })
    return {
      kind: 'agent-turn',
      agent: completion?.lannr?.agent ?? null,
      provider: completion?.lannr?.provider ?? null,
      model: completion?.model ?? null,
      answer: completion?.choices?.[0]?.message?.content ?? '',
    }
  }
  const routine = await runtime.memory.get(reactive.routineId)
  if (!routine) throw new Error(`routine-not-found: ${reactive.routineId}`)
  const input = reactive.inputMapper && payload !== undefined
    ? evaluateInputMapper(reactive.inputMapper, payload)
    : reactive.input
  return runtime.lannr.runRoutine(routine, input)
}

export async function startHubScheduler(config, { pollMs = DEFAULT_POLL_MS, log }: Record<string, any> = {}) {
  const emit = typeof log === 'function' ? log : (line) => console.log(line)
  const bus = new InProcessEventBus()
  const loops = new Map()
  for (const agent of Object.values(config.agents)) {
    try {
      const runtime = await createAgentRuntime({ agentId: agent.id })
      const store = createAgentReactiveRoutineStore(runtime.agent)
      const loop = new AgentScheduleLoop({ runtime, store, bus, pollMs, log: emit })
      await loop.start()
      loops.set(runtime.agent.id, loop)
      emit(`scheduler:${runtime.agent.id} started`)
    } catch (error) {
      emit(`scheduler:${agent.id} failed to start: ${error?.message ?? error}`)
    }
  }
  const registry = {
    bus,
    getLoop: (agentId) => loops.get(agentId),
    listAgents: () => [...loops.keys()],
    async stop() {
      await Promise.all([...loops.values()].map((loop) => loop.stop()))
      loops.clear()
    },
  }
  return registry
}

export class AgentScheduleLoop {
  [key: string]: any

  constructor({ runtime, store, bus, pollMs, log }) {
    this.runtime = runtime
    this.store = store
    this.bus = bus
    this.pollMs = pollMs
    this.log = log
    this.running = false
    this.locks = new Set()
    this.timer = null
    this.unsubscribes = []
  }

  async start() {
    if (this.running) return
    this.running = true
    await this.subscribeEvents()
    this.schedule(0)
  }

  async stop() {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const unsub of this.unsubscribes) {
      try { unsub() } catch {}
    }
    this.unsubscribes = []
  }

  schedule(delay) {
    if (!this.running) return
    this.timer = setTimeout(() => { this.tick().catch(() => {}) }, delay)
  }

  async tick() {
    try {
      const due = await this.store.getDue(new Date(), undefined)
      await Promise.allSettled(due.map((routine) => this.execute(routine, undefined)))
    } catch (error) {
      this.log(`scheduler:${this.runtime.agent.id} tick error: ${error?.message ?? error}`)
    } finally {
      this.schedule(this.pollMs)
    }
  }

  async subscribeEvents() {
    if (!this.bus) return
    const routines = await this.store.list()
    for (const routine of routines) {
      if (routine.enabled && routine.trigger?.type === 'event') {
        const unsub = this.bus.subscribe(routine.trigger.event, async (payload) => {
          const fresh = await this.store.get(routine.id, undefined)
          if (!fresh || !fresh.enabled) return
          await this.execute(fresh, payload)
        })
        this.unsubscribes.push(unsub)
      }
    }
  }

  async runNow(id, payload) {
    const reactive = await this.store.get(id)
    if (!reactive) throw new Error(`Reactive routine not found: ${id}`)
    return this.execute(reactive, payload)
  }

  async handleWebhook(id, payload, presentedSecret) {
    const reactive = await this.store.get(id)
    if (!reactive) throw new Error(`Reactive routine not found: ${id}`)
    if (reactive.trigger?.type !== 'webhook') throw new Error(`Reactive routine ${id} is not a webhook routine`)
    if (!constantTimeEqual(reactive.trigger.secret, presentedSecret)) {
      throw new Error('Invalid webhook secret')
    }
    return this.execute(reactive, payload)
  }

  async execute(reactive, payload) {
    if (this.locks.has(reactive.id) || !reactive.enabled) return null
    this.locks.add(reactive.id)
    const label = reactive.description || reactive.agentTurn?.prompt?.slice(0, 60) || reactive.routineId
    this.log(`scheduler:${this.runtime.agent.id} running ${reactive.id} (${label})`)
    try {
      await this.store.markRunning(reactive.id)
      const result = await executeScheduledAction(this.runtime, reactive, payload)
      await this.store.recordSuccess(reactive.id, result)
      return result
    } catch (error) {
      const next = await this.store.recordFailure(reactive.id, error)
      this.log(`scheduler:${this.runtime.agent.id} ${reactive.id} failed: ${error?.message ?? error}`)
      if (next.consecutiveFailures >= next.failureThreshold) {
        await this.store.disable(reactive.id)
        this.log(`scheduler:${this.runtime.agent.id} ${reactive.id} disabled after ${next.consecutiveFailures} consecutive failures`)
      }
      throw error
    } finally {
      this.locks.delete(reactive.id)
    }
  }
}

function constantTimeEqual(expected, presented) {
  const a = Buffer.from(String(expected ?? ''), 'utf8')
  const b = Buffer.from(String(presented ?? ''), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
