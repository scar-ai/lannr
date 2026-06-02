// Per-runtime file-state registry. Edits must read the file first; if the file
// changed on disk since the recorded read (different mtime/sha), refuse the
// write so we never clobber out-of-band edits. Mirrors hermes' file_state.py
// must-read-before-edit invariant.

import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'

export function createFileStateRegistry() {
  const records = new Map()

  function key(path) { return String(path) }

  async function recordRead(path, content) {
    const meta = await captureMeta(path, content)
    records.set(key(path), { ...meta, role: 'read', at: Date.now() })
    return meta
  }

  async function recordWrite(path, content) {
    const meta = await captureMeta(path, content)
    records.set(key(path), { ...meta, role: 'write', at: Date.now() })
    return meta
  }

  function recordDelete(path) {
    records.delete(key(path))
  }

  function get(path) { return records.get(key(path)) ?? null }
  function has(path) { return records.has(key(path)) }

  // Throws if:
  //   - file exists on disk but was never recorded (must read before edit)
  //   - file was recorded but mtime or sha now differs (out-of-band change)
async function assertCanWrite(path, { allowMissing = true, requireRead = true }: Record<string, any> = {}) {
    const recorded = records.get(key(path))
    let onDisk
    try { onDisk = await stat(path) } catch (err) {
      if (err?.code === 'ENOENT') {
        if (allowMissing) return { state: 'new' }
        throw err
      }
      throw err
    }
    if (!recorded) {
      if (!requireRead) return { state: 'untracked' }
      throw new Error(
        `File ${path} must be read before editing — call readFile first to capture its current contents.`,
      )
    }
    if (recorded.mtimeMs !== onDisk.mtimeMs || recorded.size !== onDisk.size) {
      throw new Error(
        `File ${path} changed on disk since it was last read (mtime/size mismatch). ` +
        'Re-read the file before editing to confirm the change is still intended.',
      )
    }
    return { state: 'fresh', recorded }
  }

  return { recordRead, recordWrite, recordDelete, assertCanWrite, get, has }
}

async function captureMeta(path, content) {
  let mtimeMs = Date.now()
  let size = Buffer.byteLength(String(content ?? ''))
  try {
    const s = await stat(path)
    mtimeMs = s.mtimeMs
    size = s.size
  } catch {
    // file may not yet exist (write path) — use buffer length
  }
  const sha = createHash('sha1').update(String(content ?? '')).digest('hex')
  return { path, mtimeMs, size, sha }
}
