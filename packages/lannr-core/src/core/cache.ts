import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

export function stripComments(input: string): string {
  return input.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

export function buildCacheKey(program: string, calls: Array<{ tool: string; input: unknown }>): string {
  const normalized = {
    program: normalizeWhitespace(stripComments(program)),
    calls: calls.map((call) => ({ tool: call.tool, input: stableStringify(normalizePredictedInput(call.input)) })).sort((a, b) => a.tool.localeCompare(b.tool)),
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export function predictToolCalls(program: string): Array<{ tool: string; input: unknown }> {
  const pattern = /\$(\w+)\s*\((\{[^)]*\}|['"`][\s\S]*?['"`]|[A-Za-z0-9_$.[\]-]+)\)/g
  const calls: Array<{ tool: string; input: unknown }> = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(program)) !== null) {
    calls.push({ tool: match[1], input: match[2].trim() })
  }
  return calls
}

function normalizePredictedInput(input: unknown): unknown {
  if (typeof input !== 'string') return input
  const trimmed = input.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return input
  try {
    return Function(`"use strict"; return (${trimmed})`)()
  } catch {
    return input
  }
}

export class MemoryCache {
  private values = new Map<string, { expiresAt: number; value: unknown }>()

  get(key: string): unknown | undefined {
    const entry = this.values.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.values.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: unknown, ttlSeconds: number): void {
    if (ttlSeconds > 0) this.values.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
  }
}

export class FileCache {
  constructor(private dir: string = '.lannr/cache') {}

  async get(key: string): Promise<unknown | undefined> {
    try {
      const entry = JSON.parse(await readFile(this.file(key), 'utf8')) as { expiresAt: number; value: unknown }
      if (Date.now() > entry.expiresAt) return undefined
      return entry.value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.file(key), JSON.stringify({ expiresAt: Date.now() + ttlSeconds * 1000, value }, null, 2))
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.json`)
  }
}
