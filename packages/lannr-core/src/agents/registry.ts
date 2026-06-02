import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { defaultWorkspaceFiles } from './templates.js'

export const SCHEMA_VERSION = 1
export const DEFAULT_AGENT_ID = 'default'
export const DEFAULT_WORKSPACE_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'IDENTITY.md',
  'USER.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
]

interface AgentRegistryOptions {
  root?: string
  path?: string
  failIfExists?: boolean
  removeCustomAgentDir?: boolean
  copyAuthFrom?: any
  existing?: any
  workspaceFiles?: Record<string, string>
  overwriteWorkspaceFiles?: boolean
}

export function agentRegistryPath({ root }: AgentRegistryOptions = {}) {
  return resolve(root ?? homedir(), '.lannr/agents.json')
}

export function lastAgentPath({ root }: AgentRegistryOptions = {}) {
  return resolve(root ?? homedir(), '.lannr/_last-agent.json')
}

export async function loadLastAgentId(options = {}) {
  try {
    const raw = await readFile(lastAgentPath(options), 'utf8')
    const parsed = JSON.parse(raw)
    const id = typeof parsed?.agentId === 'string' ? normalizeAgentId(parsed.agentId) : ''
    return id || null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function saveLastAgentId(agentId, options = {}) {
  const normalized = normalizeAgentId(agentId)
  if (!normalized) return null
  const path = lastAgentPath(options)
  await mkdir(dirname(path), { recursive: true })
  const payload = { agentId: normalized, updatedAt: new Date().toISOString() }
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`)
  await rename(tempPath, path)
  return normalized
}

export async function listAgents(options = {}) {
  const registry = await readAgentRegistry(options)
  return registry.agents
}

export async function getAgent(id, options = {}) {
  const registry = await readAgentRegistry(options)
  return buildAgentMaps(registry.agents).aliases.get(normalizeAgentId(id))
}

export async function upsertAgent(agent, options: AgentRegistryOptions = {}) {
  const registry = await readAgentRegistry(options)
  const normalized = normalizeAgent(agent, { defaultAgentId: registry.defaultAgentId })
  const existing = registry.agents.find((entry) => entry.id === normalized.id)
  if (existing && options.failIfExists) {
    throw new Error(`Agent "${normalized.id}" already exists.`)
  }
  assertNoAgentAliasCollision(normalized, registry.agents)
  const previousDefault = resolveDefaultAgent(registry.agents)
  await ensureAgentLayout(normalized, {
    copyAuthFrom: agent.copyAuthFromDefault === true ? previousDefault : null,
    existing,
    workspaceFiles: normalizeWorkspaceFiles(agent.workspaceFiles ?? agent.markdown, normalized),
    overwriteWorkspaceFiles: agent.overwriteWorkspaceFiles === true,
  })
  normalized.updatedAt = new Date().toISOString()
  const others = registry.agents.filter((entry) => entry.id !== normalized.id)
  const nextAgents = [...others, normalized].sort((l, r) => l.id.localeCompare(r.id))
  const nextDefaultId = agent.default === true
    ? normalized.id
    : (registry.defaultAgentId && nextAgents.some((a) => a.id === registry.defaultAgentId)
      ? registry.defaultAgentId
      : nextAgents[0]?.id ?? null)
  await writeAgentRegistry({ agents: nextAgents, defaultAgentId: nextDefaultId }, options)
  return { ...normalized, default: normalized.id === nextDefaultId }
}

export async function removeAgent(id, options = {}) {
  const registry = await readAgentRegistry(options)
  const existing = buildAgentMaps(registry.agents).aliases.get(normalizeAgentId(id))
  if (!existing) return null
  const agents = registry.agents.filter((entry) => entry.id !== existing.id)
  const nextDefaultId = registry.defaultAgentId === existing.id
    ? agents[0]?.id ?? null
    : registry.defaultAgentId
  await writeAgentRegistry({ agents, defaultAgentId: nextDefaultId }, options)
  await removeAgentDir(existing, options)
  return existing
}

export async function updateAgent(id, patch, options = {}) {
  const registry = await readAgentRegistry(options)
  const existing = buildAgentMaps(registry.agents).aliases.get(normalizeAgentId(id))
  if (!existing) return null
  const merged = { ...existing, ...patch, id: existing.id, name: patch.name ?? existing.name }
  const updated = normalizeAgent(merged, { defaultAgentId: registry.defaultAgentId })
  assertNoAgentAliasCollision(updated, registry.agents)
  updated.updatedAt = new Date().toISOString()
  const agents = registry.agents.map((entry) => entry.id === existing.id ? updated : entry)
  const nextDefaultId = patch.default === true
    ? updated.id
    : registry.defaultAgentId
  await writeAgentRegistry({ agents, defaultAgentId: nextDefaultId }, options)
  return { ...updated, default: updated.id === nextDefaultId }
}

export async function readAgentRegistry(options: AgentRegistryOptions = {}) {
  try {
    const raw = await readFile(options.path ?? agentRegistryPath(options), 'utf8')
    return loadAgentRegistry(JSON.parse(raw))
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: SCHEMA_VERSION, defaultAgentId: null, agents: [] }
    throw error
  }
}

export function buildAgentMaps(agents) {
  const canonical = new Map()
  const aliases = new Map()
  for (const agent of agents) {
    canonical.set(agent.id, agent)
    aliases.set(agent.id, agent)
    aliases.set(normalizeAgentId(agent.name), agent)
    for (const alias of agent.aliases) {
      aliases.set(normalizeAgentId(alias), agent)
    }
  }
  return { canonical, aliases }
}

export function resolveDefaultAgent(agents) {
  return agents.find((agent) => agent.default) ?? agents[0] ?? null
}

export function normalizeAgentId(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

// ── Schema load + migration ──────────────────────────────────────────────────

function loadAgentRegistry(value) {
  if (!value || typeof value !== 'object') {
    return { schemaVersion: SCHEMA_VERSION, defaultAgentId: null, agents: [] }
  }
  const versioned = typeof value.schemaVersion === 'number' ? value : migrateFromV0(value)
  const rawAgents = Array.isArray(versioned.agents) ? versioned.agents : []
  const defaultAgentId = versioned.defaultAgentId ? normalizeAgentId(versioned.defaultAgentId) : null
  const agents = rawAgents.map((a) => normalizeAgent(a, { defaultAgentId })).filter((a) => a.id)
  const resolvedDefaultId = defaultAgentId && agents.some((a) => a.id === defaultAgentId)
    ? defaultAgentId
    : (agents[0]?.id ?? null)
  return {
    schemaVersion: SCHEMA_VERSION,
    defaultAgentId: resolvedDefaultId,
    agents: agents.map((a) => ({ ...a, default: a.id === resolvedDefaultId })),
  }
}

function migrateFromV0(value) {
  const agents = Array.isArray(value.agents) ? value.agents : []
  const defaultEntry = agents.find((a) => a?.default) ?? agents[0]
  return {
    schemaVersion: SCHEMA_VERSION,
    defaultAgentId: defaultEntry ? normalizeAgentId(defaultEntry.id ?? defaultEntry.name) : null,
    agents,
  }
}

// ── Per-agent normalization ──────────────────────────────────────────────────

function normalizeAgent(value, { defaultAgentId = null } = {}): any {
  const id = normalizeAgentId(value.id ?? value.name)
  if (!id) throw new Error('Agent name is required')
  const name = stringOr(value.name, id)
  const paths = normalizePaths(id, value.paths, value)
  const providerConfig = normalizeProvider(value.providerConfig ?? value.provider)
  const identity = normalizeIdentity(value.identity, name)
  return {
    id,
    name,
    description: stringOr(value.description, ''),
    instructions: stringOr(value.instructions, ''),
    aliases: arrayOfStrings(value.aliases),
    provider: providerConfig.id,
    providerConfig,
    identity,
    bindings: normalizeBindings(value.bindings),
    deniedSkills: normalizeSkillList(value.deniedSkills ?? value.denySkills),
    globalReach: Boolean(value.globalReach ?? value.globalreach),
    paths,
    workspace: paths.workspace,
    agentDir: paths.agentDir,
    sessionsDir: paths.sessionsDir,
    default: defaultAgentId ? id === normalizeAgentId(defaultAgentId) : Boolean(value.default),
    createdAt: stringOr(value.createdAt, new Date().toISOString()),
    updatedAt: stringOr(value.updatedAt, new Date().toISOString()),
  }
}

function normalizePaths(id, paths, legacy) {
  const input = paths && typeof paths === 'object' ? paths : {}
  const workspace = expandUserPath(stringOr(input.workspace, legacy.workspace, defaultAgentWorkspace(id)))
  const agentDir = expandUserPath(stringOr(input.agentDir, legacy.agentDir, defaultAgentDir(id)))
  const sessionsDir = expandUserPath(stringOr(input.sessionsDir, legacy.sessionsDir, join(agentDir, 'sessions')))
  return { workspace, agentDir, sessionsDir }
}

function normalizeProvider(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = normalizeAgentId(value.id ?? value.name ?? 'default') || 'default'
    const out: any = { id }
    if (typeof value.model === 'string' && value.model.trim()) out.model = value.model.trim()
    if (value.params && typeof value.params === 'object') out.params = value.params
    return out
  }
  return { id: normalizeAgentId(value ?? 'default') || 'default' }
}

export function defaultAgentWorkspace(agentId) {
  return join(defaultAgentDir(agentId), 'workspace')
}

export function defaultAgentDir(agentId) {
  return join(homedir(), '.lannr', 'agents', agentId)
}

// ── Filesystem layout ────────────────────────────────────────────────────────

async function removeAgentDir(agent, options: AgentRegistryOptions = {}) {
  const agentDir = resolve(agent.agentDir)
  const expectedAgentDir = resolve(defaultAgentDir(agent.id))
  const rootAgentDir = resolve(options.root ?? homedir(), '.lannr', 'agents', agent.id)
  if (
    agentDir !== expectedAgentDir &&
    agentDir !== rootAgentDir &&
    options.removeCustomAgentDir !== true
  ) {
    return
  }
  await rm(agentDir, { recursive: true, force: true })
}

export async function ensureAgentLayout(agent, options: AgentRegistryOptions = {}) {
  await mkdir(agent.workspace, { recursive: true })
  await mkdir(agent.agentDir, { recursive: true })
  await mkdir(join(agent.agentDir, 'agent'), { recursive: true })
  await mkdir(agent.sessionsDir, { recursive: true })
  await ensureWorkspaceFiles(agent, options)
  if (options.copyAuthFrom) {
    await copyPortableAuthProfiles(options.copyAuthFrom, agent)
  }
}

async function ensureWorkspaceFiles(agent, options: AgentRegistryOptions = {}) {
  const files = options.workspaceFiles ?? defaultWorkspaceFiles(agent)
  for (const fileName of DEFAULT_WORKSPACE_FILES) {
    const content = files[fileName] ?? defaultWorkspaceFiles(agent)[fileName]
    const filePath = join(agent.workspace, fileName)
    if (options.overwriteWorkspaceFiles) {
      await writeFile(filePath, ensureTrailingNewline(content), 'utf8')
    } else {
      await writeIfMissing(filePath, ensureTrailingNewline(content))
    }
  }
}

async function writeIfMissing(path, content) {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
}

async function copyPortableAuthProfiles(sourceAgent, targetAgent) {
  if (!sourceAgent?.agentDir || sourceAgent.id === targetAgent.id) return
  const sourcePath = join(sourceAgent.agentDir, 'agent', 'auth-profiles.json')
  const targetPath = join(targetAgent.agentDir, 'agent', 'auth-profiles.json')
  try {
    await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL)
  } catch (error) {
    if (!['ENOENT', 'EEXIST'].includes(error?.code)) throw error
  }
}

function assertNoAgentAliasCollision(incoming, agents) {
  const taken = new Map()
  for (const other of agents) {
    if (other.id === incoming.id) continue
    taken.set(other.id, other.id)
    for (const alias of other.aliases) taken.set(normalizeAgentId(alias), other.id)
  }
  const incomingKeys = [incoming.id, ...incoming.aliases.map(normalizeAgentId)].filter(Boolean)
  for (const key of incomingKeys) {
    if (taken.has(key)) {
      throw new Error(`Agent name or alias "${key}" is already used by "${taken.get(key)}".`)
    }
  }
}

function normalizeIdentity(value, fallbackName) {
  const input = value && typeof value === 'object' ? value : {}
  return {
    name: stringOr(input.name, fallbackName),
    theme: stringOr(input.theme),
    emoji: stringOr(input.emoji),
    avatar: stringOr(input.avatar),
  }
}

function normalizeBindings(value) {
  return Array.isArray(value)
    ? value.map((binding) => typeof binding === 'string' ? { route: binding.trim() } : binding)
      .filter((binding) => binding && typeof binding === 'object')
    : []
}

function normalizeWorkspaceFiles(value, agent) {
  const input = value && typeof value === 'object' ? value : {}
  const defaults = defaultWorkspaceFiles(agent)
  return Object.fromEntries(DEFAULT_WORKSPACE_FILES.map((fileName) => [
    fileName,
    typeof input[fileName] === 'string' && input[fileName].trim()
      ? input[fileName]
      : defaults[fileName],
  ]))
}

function ensureTrailingNewline(value) {
  return value.endsWith('\n') ? value : `${value}\n`
}

// ── Persistence ──────────────────────────────────────────────────────────────

async function writeAgentRegistry(registry, options: AgentRegistryOptions = {}) {
  const path = options.path ?? agentRegistryPath(options)
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(serializeRegistry(registry), null, 2)}\n`)
  await rename(tempPath, path)
}

function serializeRegistry({ agents, defaultAgentId }) {
  const cleaned = (agents ?? []).map(serializeAgent)
  return {
    schemaVersion: SCHEMA_VERSION,
    defaultAgentId: defaultAgentId ?? cleaned[0]?.id ?? null,
    agents: cleaned,
  }
}

function serializeAgent(agent) {
  const out: any = {
    id: agent.id,
    name: agent.name,
  }
  if (agent.description) out.description = agent.description
  if (agent.instructions) out.instructions = agent.instructions
  if (agent.aliases?.length) out.aliases = agent.aliases
  out.provider = agent.providerConfig ?? { id: agent.provider ?? 'default' }
  if (agent.identity && Object.values(agent.identity).some(Boolean)) out.identity = agent.identity
  if (agent.bindings?.length) out.bindings = agent.bindings
  if (agent.deniedSkills?.length) out.deniedSkills = agent.deniedSkills
  if (agent.globalReach) out.globalReach = true
  const overrides = pathOverrides(agent)
  if (overrides) out.paths = overrides
  out.createdAt = agent.createdAt
  out.updatedAt = agent.updatedAt
  return out
}

function pathOverrides(agent) {
  const overrides: any = {}
  const expectedWorkspace = resolve(expandUserPath(defaultAgentWorkspace(agent.id)))
  const expectedAgentDir = resolve(expandUserPath(defaultAgentDir(agent.id)))
  const expectedSessionsDir = resolve(join(expectedAgentDir, 'sessions'))
  if (agent.workspace && resolve(agent.workspace) !== expectedWorkspace) overrides.workspace = agent.workspace
  if (agent.agentDir && resolve(agent.agentDir) !== expectedAgentDir) overrides.agentDir = agent.agentDir
  if (agent.sessionsDir && resolve(agent.sessionsDir) !== expectedSessionsDir) overrides.sessionsDir = agent.sessionsDir
  return Object.keys(overrides).length ? overrides : null
}

// ── Tiny helpers ─────────────────────────────────────────────────────────────

function stringOr(...values) {
  const value = values.find((item) => typeof item === 'string' && item.trim().length > 0)
  return value?.trim()
}

function arrayOfStrings(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : []
}

function normalizeSkillList(value) {
  return [...new Set(arrayOfStrings(value).map(normalizeAgentId).filter(Boolean))].sort()
}

function expandUserPath(value) {
  if (!value) return value
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}
