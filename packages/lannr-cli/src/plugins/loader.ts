import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function pluginsHome() {
  return resolve(process.env.LANNR_HOME ?? resolve(homedir(), '.lannr'), 'plugins')
}

export function pluginsRegistryPath() {
  return resolve(process.env.LANNR_HOME ?? resolve(homedir(), '.lannr'), 'plugins.json')
}

export async function readPluginsRegistry() {
  try {
    const raw = await readFile(pluginsRegistryPath(), 'utf8')
    const parsed = JSON.parse(raw)
    const entries = Array.isArray(parsed?.plugins) ? parsed.plugins : []
    return entries.map(normalizeRegistryEntry).filter(Boolean)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export async function writePluginsRegistry(entries) {
  const path = pluginsRegistryPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ plugins: entries.map(normalizeRegistryEntry).filter(Boolean) }, null, 2), 'utf8')
}

function normalizeRegistryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (!entry.id || !entry.path) return null
  return { id: String(entry.id), path: String(entry.path) }
}

export async function addPluginRegistryEntry(entry) {
  const entries = await readPluginsRegistry()
  const next = entries.filter((existing) => existing.id !== entry.id)
  next.push(entry)
  await writePluginsRegistry(next)
  return entry
}

export async function removePluginRegistryEntry(id) {
  const entries = await readPluginsRegistry()
  const next = entries.filter((entry) => entry.id !== id)
  const removed = entries.length !== next.length
  if (removed) await writePluginsRegistry(next)
  return removed
}

export async function listAvailablePlugins() {
  const entries = await readPluginsRegistry()
  const seenIds = new Set(entries.map((entry) => entry.id))
  const autoDir = pluginsHome()
  let autoFiles = []
  try {
    autoFiles = await readdir(autoDir)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const name of autoFiles) {
    if (!name.endsWith('.js') && !name.endsWith('.mjs')) continue
    const id = name.replace(/\.(js|mjs)$/i, '')
    if (seenIds.has(id)) continue
    entries.push({ id, path: resolve(autoDir, name), auto: true })
  }
  return entries
}

async function importPluginModule(path) {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path)
  try {
    await stat(abs)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Plugin file not found: ${path}`)
    throw error
  }
  return import(pathToFileURL(abs).href)
}

async function toolsFromModule(mod, ctx) {
  let exported
  if (typeof mod.default === 'function') exported = await mod.default(ctx)
  else if (typeof mod.createTools === 'function') exported = await mod.createTools(ctx)
  else if (Array.isArray(mod.tools)) exported = mod.tools
  else if (Array.isArray(mod.default)) exported = mod.default
  else return []
  if (!Array.isArray(exported)) return []
  return exported.filter((tool) => tool && typeof tool === 'object' && typeof tool.name === 'string')
}

export async function loadAgentPlugins(ctx) {
  const entries = await listAvailablePlugins()
  const result = []
  for (const entry of entries) {
    try {
      const mod = await importPluginModule(entry.path)
      const tools = await toolsFromModule(mod, ctx)
      for (const toolDef of tools) {
        result.push({ ...toolDef, external: toolDef.external ?? true })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[lannr] failed to load plugin ${entry.id}: ${message}\n`)
    }
  }
  return result
}
