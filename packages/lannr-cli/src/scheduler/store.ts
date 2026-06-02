import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getNextRun } from 'lannr-extras/scheduler'

export function agentSchedulerDir(agent) {
  return resolve(agent.agentDir, 'scheduler')
}

export function createAgentReactiveRoutineStore(agent) {
  return new FileReactiveRoutineStore(agentSchedulerDir(agent))
}

export class FileReactiveRoutineStore {
  [key: string]: any

  constructor(dir) {
    this.dir = dir
  }

  async save(routine) {
    await mkdir(this.routinesDir(), { recursive: true })
    await writeFile(this.routinePath(routine.id), JSON.stringify(serializeRoutine(routine), null, 2), 'utf8')
  }

  async get(id) {
    try {
      return deserializeRoutine(JSON.parse(await readFile(this.routinePath(id), 'utf8')))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async list() {
    await mkdir(this.routinesDir(), { recursive: true })
    const files = (await readdir(this.routinesDir())).filter((file) => file.endsWith('.json'))
    const routines = await Promise.all(files.map((file) => this.get(file.slice(0, -5))))
    return routines.filter(Boolean).sort((left, right) => left.id.localeCompare(right.id))
  }

  async getDue(now) {
    return (await this.list()).filter((routine) => {
      return routine.enabled
        && ['cron', 'once', 'interval'].includes(routine.trigger.type)
        && routine.nextRunAt
        && routine.nextRunAt <= now
        && !isActivelyRunning(routine, now)
    })
  }

  async markRunning(id, { pid }: Record<string, any> = {}) {
    const routine = await requireReactiveRoutine(this, id)
    await this.save({ ...routine, runningSince: new Date(), runningPid: pid ?? process.pid })
  }

  async recordSuccess(id, result) {
    const routine = await requireReactiveRoutine(this, id)
    const nextRunAt = computeNextRunAt({ ...routine, lastRunStatus: 'success' })
    const enabled = routine.trigger.type === 'once' ? false : routine.enabled
    await this.save({
      ...routine,
      enabled,
      lastRunAt: new Date(),
      lastRunStatus: 'success',
      consecutiveFailures: 0,
      nextRunAt,
      runningSince: null,
      runningPid: null,
    })
    await this.appendResult(id, { status: 'success', result, createdAt: new Date() })
  }

  async recordFailure(id, error) {
    const routine = await requireReactiveRoutine(this, id)
    const consecutiveFailures = routine.consecutiveFailures + 1
    const delayMs = Math.min(300, 2 ** routine.consecutiveFailures * 30) * 1000
    const nextRunAt = routine.trigger.type === 'cron' || routine.trigger.type === 'interval'
      ? new Date(Date.now() + delayMs)
      : routine.nextRunAt
    const next = {
      ...routine,
      lastRunAt: new Date(),
      lastRunStatus: 'failure',
      consecutiveFailures,
      nextRunAt,
      runningSince: null,
      runningPid: null,
    }
    await this.save(next)
    await this.appendResult(id, { status: 'failure', error: formatError(error), createdAt: new Date() })
    return next
  }

  async disable(id) {
    const routine = await requireReactiveRoutine(this, id)
    await this.save({ ...routine, enabled: false })
  }

  async enable(id) {
    const routine = await requireReactiveRoutine(this, id)
    const nextRunAt = computeNextRunAt(routine, new Date())
    await this.save({ ...routine, enabled: true, consecutiveFailures: 0, nextRunAt })
  }

  async delete(id) {
    await rm(this.routinePath(id), { force: true })
  }

  async results(id) {
    try {
      const rows = JSON.parse(await readFile(this.resultsPath(id), 'utf8'))
      return Array.isArray(rows) ? rows : []
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  async appendResult(id, entry) {
    await mkdir(this.resultsDir(), { recursive: true })
    const rows = await this.results(id)
    rows.push(serializeDates(entry))
    await writeFile(this.resultsPath(id), JSON.stringify(rows.slice(-100), null, 2), 'utf8')
  }

  routinesDir() {
    return join(this.dir, 'routines')
  }

  resultsDir() {
    return join(this.dir, 'results')
  }

  routinePath(id) {
    return join(this.routinesDir(), `${safeId(id)}.json`)
  }

  resultsPath(id) {
    return join(this.resultsDir(), `${safeId(id)}.json`)
  }
}

async function requireReactiveRoutine(store, id) {
  const routine = await store.get(id)
  if (!routine) throw new Error(`ReactiveRoutine not found: ${id}`)
  return routine
}

function serializeRoutine(routine) {
  return serializeDates(routine)
}

function deserializeRoutine(raw) {
  return {
    ...raw,
    lastRunAt: raw.lastRunAt ? new Date(raw.lastRunAt) : null,
    nextRunAt: raw.nextRunAt ? new Date(raw.nextRunAt) : null,
    createdAt: raw.createdAt ? new Date(raw.createdAt) : new Date(),
    runningSince: raw.runningSince ? new Date(raw.runningSince) : null,
    runningPid: raw.runningPid ?? null,
  }
}

function serializeDates(value) {
  return JSON.parse(JSON.stringify(value))
}

function formatError(error) {
  return error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
}

const STALE_RUNNING_MS = 30 * 60 * 1000

function isActivelyRunning(routine, now) {
  if (!routine.runningSince) return false
  const startedMs = routine.runningSince instanceof Date ? routine.runningSince.getTime() : new Date(routine.runningSince).getTime()
  return Number.isFinite(startedMs) && now.getTime() - startedMs <= STALE_RUNNING_MS
}

function safeId(id) {
  const value = String(id ?? '').trim()
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`Invalid reactive routine id: ${id}`)
  return value
}

function computeNextRunAt(routine, now = new Date()) {
  if (routine.trigger?.type === 'cron') return getNextRun(routine.trigger.cron, now)
  if (routine.trigger?.type === 'interval') return new Date(now.getTime() + Number(routine.trigger.intervalMs ?? 0))
  if (routine.trigger?.type === 'once' && routine.lastRunStatus === 'success') return null
  return routine.nextRunAt
}
