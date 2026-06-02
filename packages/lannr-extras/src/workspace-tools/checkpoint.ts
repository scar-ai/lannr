import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

const DEFAULT_KEEP = 20
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024
const DEFAULT_EXCLUDE_DIRS = new Set(['.git', '.lannr', 'node_modules', '.next', 'dist', 'build', '.turbo', '.cache', 'coverage'])

interface CheckpointOptions {
  enabled?: boolean
  keep?: number
  maxFileBytes?: number
  excludeDirs?: string[]
}

export function createCheckpointManager(agent, opts: CheckpointOptions = {}) {
  const enabled = opts.enabled ?? true
  const workspace = resolve(agent.workspace)
  const rootDir = resolve(agent.agentDir, 'checkpoints')
  const objectsDir = join(rootDir, 'objects')
  const manifestsDir = join(rootDir, 'manifests')
  const keep = opts.keep ?? DEFAULT_KEEP
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const excludeDirs = new Set([...(opts.excludeDirs ?? []), ...DEFAULT_EXCLUDE_DIRS])

  async function ensureDirs() {
    await mkdir(objectsDir, { recursive: true })
    await mkdir(manifestsDir, { recursive: true })
  }

  async function snapshot(turnId, parentTurnId) {
    if (!enabled) return null
    await ensureDirs()
    const files = []
    await walk(workspace, files)
    const manifest = {
      turnId,
      parentTurnId: parentTurnId ?? null,
      createdAt: new Date().toISOString(),
      agentId: agent.id,
      workspace,
      files,
    }
    await writeFile(join(manifestsDir, `${turnId}.json`), JSON.stringify(manifest, null, 2), 'utf8')
    await prune()
    return manifest
  }

  async function list() {
    try {
      const names = await readdir(manifestsDir)
      const out = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        try {
          const raw = await readFile(join(manifestsDir, name), 'utf8')
          const manifest = JSON.parse(raw)
          out.push({
            turnId: manifest.turnId,
            createdAt: manifest.createdAt,
            agentId: manifest.agentId,
            parentTurnId: manifest.parentTurnId ?? null,
            fileCount: manifest.files?.length ?? 0,
          })
        } catch {
          // skip corrupt manifests
        }
      }
      return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  async function read(turnId) {
    try {
      const raw = await readFile(join(manifestsDir, `${turnId}.json`), 'utf8')
      return JSON.parse(raw)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async function restore(turnId) {
    const manifest = await read(turnId)
    if (!manifest) throw new Error(`Checkpoint not found: ${turnId}`)
    const tracked = new Map()
    for (const entry of manifest.files ?? []) tracked.set(entry.relPath, entry)

    // Restore files from CAS.
    for (const entry of tracked.values()) {
      const target = resolve(workspace, entry.relPath)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(objectsDir, entry.sha256), target)
    }

    // Remove files created after the snapshot but not in it.
    const current = []
    await walk(workspace, current)
    const removed = []
    for (const entry of current) {
      if (!tracked.has(entry.relPath)) {
        const target = resolve(workspace, entry.relPath)
        try {
          await unlink(target)
          removed.push(entry.relPath)
        } catch {
          // ignore unlink failures (e.g. concurrent edits)
        }
      }
    }
    return { restored: tracked.size, removed, manifest }
  }

  async function prune() {
    const entries = await list()
    if (entries.length <= keep) return { kept: entries.length, deleted: 0 }
    const toDelete = entries.slice(keep)
    let deleted = 0
    for (const entry of toDelete) {
      try {
        await unlink(join(manifestsDir, `${entry.turnId}.json`))
        deleted++
      } catch {
        // ignore
      }
    }
    return { kept: entries.length - deleted, deleted }
  }

  async function walk(dir, out, depth = 0) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.gitignore') continue
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue
        if (depth > 12) continue
        await walk(join(dir, entry.name), out, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const full = join(dir, entry.name)
      const info = await stat(full).catch(() => null)
      if (!info) continue
      if (info.size > maxFileBytes) continue
      const buf = await readFile(full)
      const sha256 = createHash('sha256').update(buf).digest('hex')
      const objectPath = join(objectsDir, sha256)
      await writeIfMissing(objectPath, buf)
      out.push({
        relPath: relative(workspace, full),
        sha256,
        size: info.size,
        mode: info.mode,
      })
    }
  }

  async function writeIfMissing(path, data) {
    try {
      await stat(path)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await writeFile(path, data)
    }
  }

  return { snapshot, restore, list, read, prune, rootDir }
}
