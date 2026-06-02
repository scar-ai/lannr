import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z, type ZodTypeAny } from 'zod'
import { applyDiff, generateDiff, type MemoryLike, type RoutineLike } from 'lannr-core'
import { agentMemoryDir } from 'lannr-core/agents'

export type TrustLevel = 'draft' | 'provisional' | 'trusted' | 'pinned'

export interface ProgramDiff {
  version: number
  patch: string
  diff?: string
  reason: string
  appliedAt: Date
  outcome: 'success' | 'failure' | 'rolled-back'
  resultedIn?: 'success' | 'failure'
  failureError?: string
  type?: 'diff' | 'full-rewrite'
}

export interface Routine extends RoutineLike {
  version: number
  changelog: ProgramDiff[]
  createdAt: Date
  updatedAt: Date
}

export const TRUST_THRESHOLDS = {
  provisional: { minRuns: 5, minSuccessRate: 0.85 },
  trusted: { minRuns: 50, minSuccessRate: 0.93 },
} as const

export interface MemoryStore extends MemoryLike {
  save(routine: RoutineLike | Routine): Promise<void>
  get(id: string): Promise<Routine | null>
  list(filter?: { tags?: string[]; minTrust?: TrustLevel }): Promise<Array<Pick<Routine, 'id' | 'name' | 'description' | 'tags' | 'trust'>>>
  patch(id: string, diff: PatchRoutineInput): Promise<Routine>
  delete(id: string): Promise<void>
  recordRun?(id: string, success: boolean): Promise<Routine>
}

export interface PatchRoutineInput {
  diff?: string
  patch?: string
  reason: string
  expectedVersion?: number
  outcome?: 'success' | 'failure' | 'rolled-back'
  failureError?: string
  trialRun?: (program: string) => Promise<void> | void
}

export class FileMemoryStore implements MemoryStore {
  constructor(private dir: string = '.lannr/memory') {}

  async save(input: RoutineLike | Routine): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const now = new Date()
    const routine = normalizeRoutine(input, now)
    await writeFile(this.file(routine.id), JSON.stringify(serializeRoutine(routine), null, 2))
  }

  async get(id: string): Promise<Routine | null> {
    try {
      return deserializeRoutine(JSON.parse(await readFile(this.file(id), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async list(filter: { tags?: string[]; minTrust?: TrustLevel } = {}): Promise<Array<Pick<Routine, 'id' | 'name' | 'description' | 'tags' | 'trust'>>> {
    await mkdir(this.dir, { recursive: true })
    const files = (await readdir(this.dir)).filter((file) => file.endsWith('.json'))
    const routines = (await Promise.all(files.map((file) => this.get(path.basename(file, '.json'))))).filter((routine): routine is Routine => Boolean(routine))
    return routines
      .filter((routine) => !filter.tags?.length || filter.tags.some((tag) => routine.tags.includes(tag)))
      .filter((routine) => !filter.minTrust || trustRank(routine.trust.level) >= trustRank(filter.minTrust))
      .map(({ id, name, description, tags, trust }) => ({ id, name, description, tags, trust }))
  }

  async patch(id: string, patchInput: PatchRoutineInput): Promise<Routine> {
    const routine = await this.get(id)
    if (!routine) throw new Error(`Routine not found: ${id}`)
    if (patchInput.expectedVersion !== undefined && routine.version !== patchInput.expectedVersion) throw new Error(`Routine ${id} version conflict: expected ${patchInput.expectedVersion}, found ${routine.version}`)
    const patch = patchInput.patch ?? patchInput.diff
    if (!patch) throw new Error('Patch is required')
    const applied = applyDiff(routine.program, patch)
    if (!applied.ok) {
      const appliedError = (applied as { ok: false; error: string }).error
      const failed = appendDiff(routine, patch, patchInput.reason, 'failure', patchInput.failureError ?? appliedError)
      await this.save(failed)
      throw new Error(appliedError)
    }
    try {
      validateJavaScriptProgram(applied.program)
      await patchInput.trialRun?.(applied.program)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed = appendDiff(routine, patch, patchInput.reason, 'failure', message)
      await this.save(failed)
      throw error
    }
    const version = routine.version + 1
    const type = patch.length > routine.program.length * 0.8 ? 'full-rewrite' : 'diff'
    const next: Routine = {
      ...routine,
      program: applied.program,
      version,
      updatedAt: new Date(),
      changelog: [...routine.changelog, { version, patch, diff: patch, reason: patchInput.reason, appliedAt: new Date(), outcome: patchInput.outcome ?? 'success', resultedIn: 'success', failureError: patchInput.failureError, type }],
    }
    await this.save(next)
    return next
  }

  async delete(id: string): Promise<void> {
    await rm(this.file(id), { force: true })
  }

  async recordRun(id: string, success: boolean): Promise<Routine> {
    const routine = await this.get(id)
    if (!routine) throw new Error(`Routine not found: ${id}`)
    const runs = routine.trust.runs + 1
    const successfulRuns = routine.trust.successfulRuns + (success ? 1 : 0)
    const successRate = successfulRuns / runs
    const level = nextTrustLevel(routine.trust.level, runs, successRate)
    const next = { ...routine, trust: { runs, successfulRuns, successRate, level }, updatedAt: new Date() }
    await this.save(next)
    return next
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`)
  }
}

export class HttpMemoryStore implements MemoryStore {
  constructor(private baseURL: string, private headers: Record<string, string> = {}) {}
  async save(routine: RoutineLike | Routine): Promise<void> { await this.request('/routines', { method: 'POST', body: JSON.stringify(serializeRoutine(normalizeRoutine(routine, new Date()))) }) }
  async get(id: string): Promise<Routine | null> { const res = await this.request(`/routines/${id}`, { method: 'GET' }, false); return res.status === 404 ? null : deserializeRoutine(await res.json()) }
  async list(filter: { tags?: string[]; minTrust?: TrustLevel } = {}) { const qs = new URLSearchParams(); filter.tags?.forEach((tag) => qs.append('tag', tag)); if (filter.minTrust) qs.set('minTrust', filter.minTrust); return await (await this.request(`/routines?${qs}`)).json() }
  async patch(id: string, diff: PatchRoutineInput) { return deserializeRoutine(await (await this.request(`/routines/${id}/patch`, { method: 'POST', body: JSON.stringify(diff) })).json()) }
  async delete(id: string): Promise<void> { await this.request(`/routines/${id}`, { method: 'DELETE' }) }
  private async request(url: string, init: RequestInit = {}, throwOnError = true) {
    const res = await fetch(`${this.baseURL}${url}`, { ...init, headers: { 'content-type': 'application/json', ...this.headers, ...init.headers } })
    if (throwOnError && !res.ok) throw new Error(`Memory request failed: ${res.status} ${await res.text()}`)
    return res
  }
}

export const SqliteMemoryStore = FileMemoryStore

export async function rollbackRoutine(store: MemoryStore, routineId: string, toVersion: number): Promise<Routine> {
  const routine = await store.get(routineId)
  if (!routine) throw new Error(`Routine ${routineId} not found`)
  if (toVersion >= routine.version) throw new Error('Can only roll back, not forward')
  const baseline = routine.changelog.find((entry) => entry.version === 1)?.patch ?? routine.program
  let program = baseline
  for (const diff of routine.changelog.filter((entry) => entry.version > 1 && entry.version <= toVersion).sort((a, b) => a.version - b.version)) {
    const result = applyDiff(program, diff.patch)
    if (!result.ok) throw new Error(`Corrupted changelog at version ${diff.version}`)
    program = result.program
  }
  return store.patch(routineId, { patch: generateDiff(routine.program, program), reason: `Rollback to version ${toVersion}`, expectedVersion: routine.version, outcome: 'rolled-back' })
}

export function schedule(name: string, config: { cron: string; routine: string; input: unknown }) {
  return { type: 'schedule' as const, name, ...config }
}

export function on(name: string, config: { event: string; routine: string; inputMapper: (event: unknown) => unknown }) {
  return { type: 'event' as const, name, ...config }
}

function normalizeRoutine(input: RoutineLike | Routine, now: Date): Routine {
  const changelog = 'changelog' in input && input.changelog?.length
    ? input.changelog.map((entry) => ({ ...entry, patch: entry.patch ?? entry.diff ?? '', outcome: entry.outcome ?? entry.resultedIn ?? 'success' }))
    : [{ version: 1, patch: input.program, diff: input.program, reason: 'Initial program', appliedAt: now, outcome: 'success' as const, resultedIn: 'success' as const, type: 'full-rewrite' as const }]
  return {
    ...input,
    version: 'version' in input ? (input.version ?? 1) : 1,
    changelog,
    createdAt: 'createdAt' in input ? input.createdAt : now,
    updatedAt: now,
  }
}

function serializeRoutine(routine: Routine) {
  return { ...routine, input: undefined, output: undefined, schema: { input: 'unknown', output: 'unknown' } }
}

function deserializeRoutine(raw: any): Routine {
  return { ...raw, input: z.unknown() as ZodTypeAny, output: z.unknown() as ZodTypeAny, createdAt: new Date(raw.createdAt), updatedAt: new Date(raw.updatedAt), changelog: (raw.changelog ?? []).map((d: any) => ({ ...d, patch: d.patch ?? d.diff, outcome: d.outcome ?? d.resultedIn ?? 'success', appliedAt: new Date(d.appliedAt) })) }
}

function trustRank(level: TrustLevel): number {
  return { draft: 0, provisional: 1, trusted: 2, pinned: 3 }[level]
}

function appendDiff(routine: Routine, patch: string, reason: string, outcome: 'failure', failureError: string): Routine {
  const version = routine.version + 1
  return { ...routine, version, updatedAt: new Date(), changelog: [...routine.changelog, { version, patch, diff: patch, reason, appliedAt: new Date(), outcome, resultedIn: 'failure', failureError, type: 'diff' }] }
}

function nextTrustLevel(current: TrustLevel, runs: number, successRate: number): TrustLevel {
  if (current === 'pinned') return 'pinned'
  if (successRate >= TRUST_THRESHOLDS.trusted.minSuccessRate && runs >= TRUST_THRESHOLDS.trusted.minRuns) return 'trusted'
  if (successRate >= TRUST_THRESHOLDS.provisional.minSuccessRate && runs >= TRUST_THRESHOLDS.provisional.minRuns) return 'provisional'
  return 'draft'
}

function validateJavaScriptProgram(program: string): void {
  new Function(`"use strict"; return (async () => {\n${program}\n})`)
}

/**
 * Memory-backed routine store rooted at an agent's `memory` directory.
 * Bridges `lannr-core` agents with the `FileMemoryStore` defined here.
 */
export function createAgentMemoryStore(agent: { agentDir: string }): FileMemoryStore {
  return new FileMemoryStore(agentMemoryDir(agent))
}
