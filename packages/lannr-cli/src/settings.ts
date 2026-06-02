import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

export const DEFAULT_MAX_ITERATIONS = 8
export const DEFAULT_CONTEXT_ENGINE_ENABLED = false

// Drives the `lannr settings` UI: each entry becomes an editable row.
export const SETTING_DEFS = [
  {
    key: 'maxIterations',
    label: 'Max iterations',
    description: 'Maximum tool-call iterations per agent run',
    type: 'number',
    default: DEFAULT_MAX_ITERATIONS,
    min: 1,
    max: 999,
    step: 1,
  },
  {
    key: 'contextEngineEnabled',
    label: 'Smart context compaction',
    description: 'LLM-summarize old turns once history exceeds the hard token budget',
    type: 'boolean',
    default: DEFAULT_CONTEXT_ENGINE_ENABLED,
  },
]

export function settingsPath({ root }: Record<string, any> = {}) {
  return resolve(root ?? homedir(), '.lannr/settings.json')
}

export async function loadSettings(options: Record<string, any> = {}) {
  try {
    const raw = await readFile(options.path ?? settingsPath(options), 'utf8')
    return normalize(JSON.parse(raw))
  } catch (error) {
    if (error?.code === 'ENOENT') return normalize({})
    throw error
  }
}

export async function saveSettings(settings, options: Record<string, any> = {}) {
  const path = options.path ?? settingsPath(options)
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(normalize(settings), null, 2)}\n`)
  await rename(tempPath, path)
}

export async function getMaxIterations(options: Record<string, any> = {}) {
  const settings = await loadSettings(options)
  return settings.maxIterations ?? DEFAULT_MAX_ITERATIONS
}

export async function setMaxIterations(value, options: Record<string, any> = {}) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`maxIterations must be a positive integer (got: ${value})`)
  }
  const settings = await loadSettings(options)
  settings.maxIterations = n
  await saveSettings(settings, options)
  return n
}

export async function getContextEngineEnabled(options: Record<string, any> = {}) {
  const settings = await loadSettings(options)
  return settings.contextEngineEnabled ?? DEFAULT_CONTEXT_ENGINE_ENABLED
}

export async function setContextEngineEnabled(value, options: Record<string, any> = {}) {
  const settings = await loadSettings(options)
  settings.contextEngineEnabled = Boolean(value)
  await saveSettings(settings, options)
  return settings.contextEngineEnabled
}

function normalize(settings) {
  const next = { ...(settings ?? {}) }
  if (next.maxIterations !== undefined) {
    const n = Number(next.maxIterations)
    next.maxIterations = Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_ITERATIONS
  }
  if (next.contextEngineEnabled !== undefined) {
    next.contextEngineEnabled = Boolean(next.contextEngineEnabled)
  }
  return next
}
