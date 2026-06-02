import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ExecutionRecord, ReplayFilter, ReplayStore } from './types.js'

export class MemoryReplayStore implements ReplayStore {
  private records = new Map<string, ExecutionRecord>()

  async save(record: ExecutionRecord): Promise<void> {
    this.records.set(record.id, record)
  }

  async get(id: string): Promise<ExecutionRecord | null> {
    return this.records.get(id) ?? null
  }

  async getByCacheKey(key: string): Promise<ExecutionRecord | null> {
    return [...this.records.values()].find((record) => record.cacheKey === key && !isExpired(record)) ?? null
  }

  async list(filter: ReplayFilter = {}): Promise<ExecutionRecord[]> {
    return applyReplayFilter([...this.records.values()], filter)
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id)
  }

  async purgeExpired(): Promise<number> {
    let count = 0
    for (const record of this.records.values()) {
      if (isExpired(record)) {
        this.records.delete(record.id)
        count++
      }
    }
    return count
  }
}

export class FileReplayStore implements ReplayStore {
  constructor(private dir: string = '.lannr/replay') {}

  async save(record: ExecutionRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.file(record.id), JSON.stringify(serializeRecord(record), null, 2))
  }

  async get(id: string): Promise<ExecutionRecord | null> {
    try {
      return deserializeRecord(JSON.parse(await readFile(this.file(id), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async getByCacheKey(key: string): Promise<ExecutionRecord | null> {
    return (await this.list()).find((record) => record.cacheKey === key && !isExpired(record)) ?? null
  }

  async list(filter: ReplayFilter = {}): Promise<ExecutionRecord[]> {
    await mkdir(this.dir, { recursive: true })
    const records = await Promise.all((await readdir(this.dir)).filter((file) => file.endsWith('.json')).map((file) => this.get(path.basename(file, '.json'))))
    return applyReplayFilter(records.filter((record): record is ExecutionRecord => Boolean(record)), filter)
  }

  async delete(id: string): Promise<void> {
    await rm(this.file(id), { force: true })
  }

  async purgeExpired(): Promise<number> {
    const expired = (await this.list()).filter(isExpired)
    await Promise.all(expired.map((record) => this.delete(record.id)))
    return expired.length
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`)
  }
}

export const SqliteReplayStore = FileReplayStore

function applyReplayFilter(records: ExecutionRecord[], filter: ReplayFilter): ExecutionRecord[] {
  return records
    .filter((record) => !filter.since || record.createdAt >= filter.since)
    .filter((record) => !filter.until || record.createdAt <= filter.until)
    .filter((record) => !filter.tool || record.resolvedBindings.some((call) => call.tool === filter.tool))
    .filter((record) => filter.minConfidence === undefined || record.confidence.score >= filter.minConfidence)
    .filter((record) => filter.hasError === undefined || Boolean(record.error) === filter.hasError)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
}

function isExpired(record: ExecutionRecord): boolean {
  return Boolean(record.expiresAt && record.expiresAt.getTime() <= Date.now())
}

function serializeRecord(record: ExecutionRecord) {
  return record
}

function deserializeRecord(raw: any): ExecutionRecord {
  return { ...raw, createdAt: new Date(raw.createdAt), expiresAt: raw.expiresAt ? new Date(raw.expiresAt) : null }
}
