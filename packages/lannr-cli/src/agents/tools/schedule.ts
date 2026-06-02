import { tool } from 'lannr-core'
import { getNextRun, getRoutineStatus } from 'lannr-extras/scheduler'
import { z } from 'zod'
import { createAgentReactiveRoutineStore } from '../../scheduler/store.js'
import { normalizeTriggerInput } from '../../scheduler/duration.js'
import {
  normalizeScheduledRoutine,
  normalizeScheduledToolCall,
  normalizeScheduleId,
  parseRunAt,
} from '../scheduling.js'

export function createScheduleTools(ctx) {
  const { agent, memory } = ctx
  const schedulerStore = createAgentReactiveRoutineStore(agent)

  return [
    tool({
      name: 'scheduleToolCall',
      description: [
        'Schedule a future workspace tool call. Use this when the user asks to do something later, such as "do this at 9am".',
        'Use runAt for a one-time ISO timestamp, or cron for a recurring five-field cron schedule.',
        'Supported toolName values are readFile, writeFile, and bash.',
      ].join(' '),
      input: z.object({
        name: z.string().optional(),
        toolName: z.enum(['readFile', 'writeFile', 'bash']).optional(),
        toolInput: z.unknown().optional(),
        input: z.unknown().optional(),
        trigger: z.object({
          type: z.enum(['runAt', 'once', 'cron']),
          runAt: z.string().optional(),
          cron: z.string().optional(),
        }).optional(),
        runAt: z.string().optional(),
        cron: z.string().optional(),
      }),
      output: z.object({
        id: z.string(),
        routineId: z.string(),
        trigger: z.object({
          type: z.string(),
          runAt: z.string().optional(),
          cron: z.string().optional(),
        }),
        enabled: z.boolean(),
      }),
      sideEffect: true,
      handler: async (input) => {
        const request = normalizeScheduledToolCall(input)
        const id = normalizeScheduleId(request.name ?? `scheduled-${Date.now()}`)
        const toolName = request.toolName
        const toolInput = request.toolInput
        const routineId = `${id}-routine`
        const routineName = `scheduled_${id.replace(/[^a-z0-9_]+/g, '_')}`
        const program = `return await $${toolName}(${JSON.stringify(toolInput)})`
        const now = new Date()
        const reactive = {
          id,
          name: id,
          routineId,
          trigger: request.cron ? { type: 'cron', cron: request.cron } : { type: 'once', runAt: parseRunAt(request.runAt).toISOString() },
          input: {},
          sink: { type: 'store' },
          enabled: true,
          lastRunAt: null,
          lastRunStatus: null,
          consecutiveFailures: 0,
          failureThreshold: 5,
          nextRunAt: request.cron ? getNextRun(request.cron) : parseRunAt(request.runAt),
          catchUp: false,
          createdAt: now,
        }
        await memory.save({
          id: routineId,
          name: routineName,
          description: `Scheduled ${toolName} call for ${id}`,
          tags: ['scheduled', toolName],
          input: z.unknown(),
          output: z.unknown(),
          program,
          trust: { runs: 0, successfulRuns: 0, successRate: 0, level: 'pinned' },
        })
        await schedulerStore.save(reactive)
        return {
          id,
          routineId,
          trigger: request.cron
            ? { type: 'cron', cron: request.cron }
            : { type: 'once', runAt: reactive.nextRunAt.toISOString() },
          enabled: true,
        }
      },
    }),
    tool({
      name: 'scheduleAgentTurn',
      description: [
        'Schedule a future or recurring agent turn. Reach for this whenever the user says "later", "at <time>", "every <duration>",',
        '"remind me to X", or otherwise asks for work to happen in the future. Do NOT try to remember it yourself.',
        'Pass: description (short, shown in listings), prompt (the natural-language request to run at fire time), and exactly one trigger:',
        '  every (recurring duration like "10m", "1h30m", "2 hours")',
        '  in    (one-shot offset like "5m" or "in 2 hours")',
        '  runAt (ISO timestamp)',
        '  cron  (five-field cron expression)',
        'Schedules persist on disk and continue running in the background as long as the Lannr hub is up.',
      ].join('\n'),
      input: z.object({
        name: z.string().optional(),
        description: z.string().min(1, 'description is required'),
        prompt: z.string().min(1, 'prompt is required'),
        agentId: z.string().optional(),
        every: z.string().optional(),
        in: z.string().optional(),
        runAt: z.string().optional(),
        cron: z.string().optional(),
        failureThreshold: z.number().int().positive().max(50).optional(),
      }),
      output: z.object({
        id: z.string(),
        description: z.string(),
        trigger: z.object({ type: z.string() }).passthrough(),
        nextRunAt: z.string().nullable(),
        enabled: z.boolean(),
      }),
      sideEffect: true,
      handler: async (input) => {
        const { trigger, nextRunAt } = normalizeTriggerInput(input)
        const id = normalizeScheduleId(input.name ?? input.description.slice(0, 32) ?? `agent-turn-${Date.now()}`)
        const reactive = {
          id,
          name: id,
          description: input.description.trim(),
          routineId: `agent-turn:${id}`,
          agentTurn: {
            prompt: input.prompt,
            agentId: input.agentId ?? agent.id,
          },
          trigger,
          input: {},
          sink: { type: 'store' },
          enabled: true,
          lastRunAt: null,
          lastRunStatus: null,
          consecutiveFailures: 0,
          failureThreshold: input.failureThreshold ?? 5,
          nextRunAt,
          catchUp: false,
          createdAt: new Date(),
        }
        await schedulerStore.save(reactive)
        return {
          id,
          description: reactive.description,
          trigger,
          nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
          enabled: true,
        }
      },
    }),
    tool({
      name: 'listScheduledActions',
      description: 'List the agent\'s scheduled and recurring actions. Returns status too: due means queued/overdue and not completed; completed requires lastRunStatus=success.',
      input: z.object({}).optional(),
      output: z.object({ actions: z.array(z.any()) }),
      handler: async () => {
        const rows = await schedulerStore.list()
        const now = new Date()
        return {
          actions: rows.map((row) => ({
            id: row.id,
            description: row.description ?? '',
            kind: row.agentTurn ? 'agent-turn' : 'routine',
            status: getRoutineStatus(row, now),
            trigger: row.trigger,
            enabled: row.enabled,
            nextRunAt: row.nextRunAt instanceof Date ? row.nextRunAt.toISOString() : row.nextRunAt ?? null,
            lastRunAt: row.lastRunAt instanceof Date ? row.lastRunAt.toISOString() : row.lastRunAt ?? null,
            lastRunStatus: row.lastRunStatus ?? null,
            prompt: row.agentTurn?.prompt ?? null,
          })),
        }
      },
    }),
    tool({
      name: 'cancelScheduledAction',
      description: 'Remove a scheduled or recurring action by id. Use after listScheduledActions to find the id.',
      input: z.object({ id: z.string().min(1) }),
      output: z.object({ id: z.string(), removed: z.boolean() }),
      sideEffect: true,
      handler: async ({ id }) => {
        const existing = await schedulerStore.get(id)
        if (!existing) return { id, removed: false }
        await schedulerStore.delete(id)
        return { id, removed: true }
      },
    }),
    tool({
      name: 'scheduleRoutine',
      description: [
        'Schedule a saved Lannr routine to run later.',
        'Use this when the user asks to run an existing saved routine at a future time or on a recurring cron schedule.',
        'routine may be a routine id or routine name. Use runAt for one-time schedules, or cron for recurring five-field cron schedules.',
      ].join(' '),
      input: z.object({
        name: z.string().optional(),
        routine: z.string().optional(),
        routineId: z.string().optional(),
        input: z.unknown().default({}),
        runAt: z.string().optional(),
        cron: z.string().optional(),
        trigger: z.object({
          type: z.enum(['runAt', 'once', 'cron']),
          runAt: z.string().optional(),
          cron: z.string().optional(),
        }).optional(),
      }),
      output: z.object({
        id: z.string(),
        routineId: z.string(),
        trigger: z.object({
          type: z.string(),
          runAt: z.string().optional(),
          cron: z.string().optional(),
        }),
        enabled: z.boolean(),
      }),
      sideEffect: true,
      handler: async (input) => {
        const request = await normalizeScheduledRoutine(input, memory)
        const id = normalizeScheduleId(request.name ?? `scheduled-${Date.now()}`)
        const nextRunAt = request.cron ? getNextRun(request.cron) : parseRunAt(request.runAt)
        const reactive = {
          id,
          name: id,
          routineId: request.routineId,
          trigger: request.cron ? { type: 'cron', cron: request.cron } : { type: 'once', runAt: nextRunAt.toISOString() },
          input: request.input,
          sink: { type: 'store' },
          enabled: true,
          lastRunAt: null,
          lastRunStatus: null,
          consecutiveFailures: 0,
          failureThreshold: 5,
          nextRunAt,
          catchUp: false,
          createdAt: new Date(),
        }
        await schedulerStore.save(reactive)
        return {
          id,
          routineId: request.routineId,
          trigger: request.cron
            ? { type: 'cron', cron: request.cron }
            : { type: 'once', runAt: nextRunAt.toISOString() },
          enabled: true,
        }
      },
    }),
  ]
}
