import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createLannr, type Message, type RoutineLike } from 'lannr-core'
import { nodeRunner } from 'lannr-core/runner-node'
import { LannrScheduler, getNextRun, getRoutineStatus, InProcessEventBus, MemoryReactiveRoutineStore, once, on, onWebhook } from './index.js'

function staticModel(responses: string[] | ((messages: Message[]) => string | Promise<string>)) {
  let index = 0
  return {
    async complete(messages: Message[]) {
      if (typeof responses === 'function') return responses(messages)
      return responses[Math.min(index++, responses.length - 1)] ?? ''
    },
  }
}

describe('scheduler subsystems', () => {
  it('executes event-triggered routines through runRoutine', async () => {
    const routine: RoutineLike = {
      id: 'routine-1',
      name: 'notify',
      description: 'notify',
      tags: [],
      input: z.object({ value: z.number() }),
      output: z.object({ doubled: z.number() }),
      program: 'const input = await $input(null)\nreturn { doubled: input.value * 2 }',
      trust: { level: 'provisional', runs: 0, successfulRuns: 0, successRate: 0 },
    }
    const memory = {
      async list() { return [{ id: routine.id, name: routine.name, description: routine.description, tags: routine.tags, trust: routine.trust }] },
      async get() { return routine },
      async save() {},
      async patch() { return routine },
    }
    const lannr = createLannr({ runner: nodeRunner(), model: staticModel(['done']), memory, tools: [] })
    const store = new MemoryReactiveRoutineStore()
    const bus = new InProcessEventBus()
    const reactive = on('event-job', {
      event: 'demo.event',
      routine: routine.id,
      inputMapper: '(event) => ({ value: event.value })',
      sink: { type: 'store' },
    })
    await store.save(reactive)
    const scheduler = new LannrScheduler(lannr, store, bus)

    const result = await scheduler.runNow('event-job', { value: 21 })
    expect(result).toEqual({ doubled: 42 })
    expect((await store.get('event-job'))?.lastRunStatus).toBe('success')
  })

  it('executes webhook-triggered routines with secret validation', async () => {
    const routine: RoutineLike = {
      id: 'routine-webhook',
      name: 'notify',
      description: 'notify',
      tags: [],
      input: z.object({ value: z.number() }),
      output: z.object({ doubled: z.number() }),
      program: 'const input = await $input(null)\nreturn { doubled: input.value * 2 }',
      trust: { level: 'draft', runs: 0, successfulRuns: 0, successRate: 0 },
    }
    const memory = {
      async list() { return [{ id: routine.id, name: routine.name, description: routine.description, tags: routine.tags, trust: routine.trust }] },
      async get() { return routine },
      async save() {},
      async patch() { return routine },
      async recordRun() { return routine },
    }
    const lannr = createLannr({ runner: nodeRunner(), model: staticModel(['done']), memory, tools: [] })
    const store = new MemoryReactiveRoutineStore()
    await store.save(onWebhook('webhook-job', {
      routine: routine.id,
      inputMapper: '(event) => ({ value: event.value })',
      secret: 'secret',
      sink: { type: 'store' },
    }))
    const scheduler = new LannrScheduler(lannr, store)

    await expect(scheduler.handleWebhook('webhook-job', { value: 1 }, 'bad')).rejects.toThrow(/Invalid webhook secret/)
    await expect(scheduler.handleWebhook('webhook-job', { value: 21 }, 'secret')).resolves.toEqual({ doubled: 42 })
  })

  it('finds the next matching five-field cron run', () => {
    const next = getNextRun('0 9 * * 1', new Date('2026-05-10T08:55:00Z'))
    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(0)
  })

  it('reports due one-shot routines as queued until they complete', async () => {
    const store = new MemoryReactiveRoutineStore()
    const reactive = once('one-shot', {
      runAt: new Date('2026-05-26T10:00:00Z'),
      routine: 'routine-1',
      input: {},
    })
    await store.save(reactive)

    const due = await store.getDue(new Date('2026-05-26T10:00:01Z'))
    expect(due).toHaveLength(1)
    expect(getRoutineStatus(due[0], new Date('2026-05-26T10:00:01Z'))).toBe('due')
    expect(due[0].lastRunAt).toBeNull()
    expect(due[0].lastRunStatus).toBeNull()

    await store.recordSuccess('one-shot', { ok: true })
    const completed = await store.get('one-shot')
    expect(completed?.nextRunAt).toBeNull()
    expect(completed?.lastRunStatus).toBe('success')
    expect(getRoutineStatus(completed!, new Date('2026-05-26T10:00:02Z'))).toBe('completed')
  })
})
