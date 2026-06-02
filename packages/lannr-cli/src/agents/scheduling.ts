import { randomUUID } from 'node:crypto'

export function normalizeScheduledToolCall(input) {
  const trigger = input.trigger ?? {}
  const runAt = input.runAt ?? trigger.runAt
  const cron = input.cron ?? trigger.cron
  const nested = input.input && typeof input.input === 'object' ? input.input : {}
  const toolName = input.toolName ?? nested.toolName
  const toolInput = input.toolInput ?? nested.toolInput ?? inferToolInput(toolName, nested)
  if (!['readFile', 'writeFile', 'bash'].includes(toolName)) {
    throw new Error('scheduleToolCall requires toolName to be one of readFile, writeFile, or bash')
  }
  if (Boolean(runAt) === Boolean(cron)) throw new Error('scheduleToolCall requires exactly one of runAt or cron')
  return {
    name: input.name ?? nested.name,
    toolName,
    toolInput,
    runAt,
    cron,
  }
}

export async function normalizeScheduledRoutine(input, memory) {
  const trigger = input.trigger ?? {}
  const runAt = input.runAt ?? trigger.runAt
  const cron = input.cron ?? trigger.cron
  const routineRef = input.routineId ?? input.routine
  if (!routineRef) throw new Error('scheduleRoutine requires routine or routineId')
  if (Boolean(runAt) === Boolean(cron)) throw new Error('scheduleRoutine requires exactly one of runAt or cron')
  const routineId = await resolveRoutineId(memory, routineRef)
  return {
    name: input.name,
    routineId,
    input: input.input ?? {},
    runAt,
    cron,
  }
}

export async function resolveRoutineId(memory, value) {
  const direct = await memory.get(value)
  if (direct) return direct.id
  const summaries = await memory.list({ minTrust: 'draft' })
  const summary = summaries.find((entry) => entry.id === value || entry.name === value)
  if (!summary) throw new Error(`Routine not found: ${value}`)
  return summary.id
}

export function inferToolInput(toolName, value) {
  if (toolName === 'writeFile') {
    return {
      path: value.path,
      content: value.content,
    }
  }
  if (toolName === 'readFile') return { path: value.path }
  if (toolName === 'bash') {
    return {
      command: value.command,
      cwd: value.cwd ?? '.',
      timeoutMs: value.timeoutMs ?? 10_000,
    }
  }
  return undefined
}

export function parseRunAt(value) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) throw new Error('runAt must be an ISO timestamp or date string parseable by JavaScript Date')
  if (date.getTime() <= Date.now()) throw new Error('runAt must be in the future')
  return date
}

export function normalizeScheduleId(value) {
  const id = String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return id || `scheduled-${randomUUID()}`
}
