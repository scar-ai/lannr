import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  listProviders,
  normalizeProviderId,
  setPrimaryProvider,
  upsertProvider,
} from '../providers/registry.js'
import { getOpenClawProviderPreset } from '../providers/openclaw-catalog.js'
import { upsertAgent } from '../agents/registry.js'
import type { ImportOptions, ImportSummary } from './hermes.js'

export async function importFromOpenClaw(
  what: 'all' | 'providers' | 'agents',
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const root = resolve(options.source || join(homedir(), '.openclaw'))
  const summary: ImportSummary = {
    source: 'openclaw',
    hermesRoot: root,
    providers: [],
    agents: [],
    notes: [],
  }

  const config = await readOpenClawConfig(root, summary)
  const wantProviders = what === 'all' || what === 'providers'
  const wantAgents = what === 'all' || what === 'agents'

  const refs = collectModelRefs(config)
  if (wantProviders) {
    await importProviders(refs, options, summary)
    if (options.setPrimary !== false && refs.defaultPrimary) {
      const id = parseProviderId(refs.defaultPrimary)
      if (id) {
        if (!options.dryRun) {
          const saved = await setPrimaryProvider(id)
          if (saved) summary.primaryProvider = saved.id
        } else {
          summary.primaryProvider = id
        }
      }
    }
  }
  if (wantAgents) {
    await importAgents(config, options, summary)
  }
  return summary
}

async function readOpenClawConfig(root: string, summary: ImportSummary): Promise<any> {
  const paths = [join(root, 'openclaw.json'), join(root, 'openclaw.json5')]
  for (const path of paths) {
    try {
      const raw = await readFile(path, 'utf8')
      return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''))
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        if (paths.indexOf(path) === paths.length - 1) {
          throw new Error(`Failed to parse OpenClaw config at ${path}: ${error.message}`)
        }
      }
    }
  }
  summary.notes.push(`No openclaw.json at ${root} — using empty config.`)
  return {}
}

interface CollectedRefs {
  defaultPrimary?: string
  byAgent: Map<string, { primary?: string; fallbacks: string[] }>
  providerIds: Set<string>
  modelsByProvider: Map<string, string[]>
  preferredModelByProvider: Map<string, string>
}

function collectModelRefs(config: any): CollectedRefs {
  const result: CollectedRefs = {
    byAgent: new Map(),
    providerIds: new Set(),
    modelsByProvider: new Map(),
    preferredModelByProvider: new Map(),
  }

  const rank = (kind: 'defaultPrimary' | 'primary' | 'fallback' | 'modelsKey') =>
    ({ defaultPrimary: 0, primary: 1, fallback: 2, modelsKey: 3 }[kind])
  const bestRank = new Map<string, number>()

  const observe = (ref: string | undefined, kind: 'defaultPrimary' | 'primary' | 'fallback' | 'modelsKey') => {
    if (!ref || typeof ref !== 'string' || !ref.includes('/')) return
    const id = parseProviderId(ref)
    if (!id) return
    const model = ref.slice(ref.indexOf('/') + 1)
    result.providerIds.add(id)
    const list = result.modelsByProvider.get(id) ?? []
    if (!list.includes(model)) list.push(model)
    result.modelsByProvider.set(id, list)
    const r = rank(kind)
    if (!bestRank.has(id) || r < (bestRank.get(id) as number)) {
      bestRank.set(id, r)
      result.preferredModelByProvider.set(id, model)
    }
  }

  for (const entry of enumerateOpenClawAgents(config)) {
    const model = entry.raw?.model
    const primary = typeof model?.primary === 'string' ? model.primary : undefined
    const fallbacks = Array.isArray(model?.fallbacks)
      ? model.fallbacks.filter((value: unknown): value is string => typeof value === 'string')
      : []
    const modelsMap = entry.raw?.models && typeof entry.raw.models === 'object' ? entry.raw.models : {}
    const modelsKeys = Object.keys(modelsMap)

    if (entry.kind === 'defaults') {
      if (primary) result.defaultPrimary = primary
      observe(primary, 'defaultPrimary')
    } else {
      result.byAgent.set(entry.id, { primary, fallbacks })
      observe(primary, 'primary')
    }
    for (const f of fallbacks) observe(f, 'fallback')
    for (const k of modelsKeys) observe(k, 'modelsKey')
  }
  return result
}

interface OpenClawAgentEntry {
  kind: 'agent' | 'defaults'
  id: string
  raw: any
}

function enumerateOpenClawAgents(config: any): OpenClawAgentEntry[] {
  const agents = (config?.agents && typeof config.agents === 'object') ? config.agents : {}
  const out: OpenClawAgentEntry[] = []
  if (agents.defaults && typeof agents.defaults === 'object') {
    out.push({ kind: 'defaults', id: 'defaults', raw: agents.defaults })
  }
  if (Array.isArray(agents.list)) {
    for (const entry of agents.list) {
      if (!entry || typeof entry !== 'object') continue
      const id = stringOf((entry as any).id ?? (entry as any).name)
      if (!id) continue
      out.push({ kind: 'agent', id, raw: entry })
    }
  }
  for (const [name, raw] of Object.entries(agents)) {
    if (name === 'defaults' || name === 'list') continue
    if (!raw || typeof raw !== 'object') continue
    out.push({ kind: 'agent', id: name, raw })
  }
  return out
}

async function importProviders(
  refs: CollectedRefs,
  options: ImportOptions,
  summary: ImportSummary,
): Promise<void> {
  const existing = await listProviders()
  const existingIds = new Set(existing.map((p) => p.id))
  for (const id of refs.providerIds) {
    const preset = getOpenClawProviderPreset(id) || {}
    const userModel = refs.preferredModelByProvider.get(id)
    const allModels = refs.modelsByProvider.get(id) ?? []
    const payload: any = {
      id,
      name: preset.name || id,
      type: preset.type || 'openai-compatible',
      baseURL: preset.baseURL,
      endpoint: preset.endpoint || 'chat-completions',
      defaultModel: userModel || preset.defaultModel,
      models: [...new Set([userModel, preset.defaultModel, ...(preset.models ?? []), ...allModels].filter(Boolean))],
      apiKeyEnv: preset.apiKeyEnv,
      apiKey: preset.apiKey,
    }
    const note = allModels.length
      ? `models in use: ${allModels.join(', ')}`
      : undefined
    const isExisting = existingIds.has(id)
    if (isExisting && !options.overwrite) {
      summary.providers.push({ id, action: 'skipped', reason: 'already exists (use --overwrite)' })
      continue
    }
    if (options.dryRun) {
      summary.providers.push({ id, action: 'planned', reason: note })
      continue
    }
    try {
      const saved = await upsertProvider(payload)
      summary.providers.push({ id: saved.id, action: isExisting ? 'updated' : 'created', reason: note })
    } catch (error: any) {
      summary.providers.push({ id, action: 'skipped', reason: error?.message ?? String(error) })
    }
  }
}

async function importAgents(
  config: any,
  options: ImportOptions,
  summary: ImportSummary,
): Promise<void> {
  const defaultsPrimary = stringOf((config?.agents?.defaults as any)?.model?.primary)
  for (const entry of enumerateOpenClawAgents(config)) {
    if (entry.kind !== 'agent') continue
    const raw = entry.raw
    const primary = stringOf(raw?.model?.primary) || defaultsPrimary
    if (!primary || !primary.includes('/')) {
      summary.agents.push({ id: entry.id, action: 'skipped', reason: 'no model.primary in "provider/model" form' })
      continue
    }
    const providerId = parseProviderId(primary)
    if (!providerId) {
      summary.agents.push({ id: entry.id, action: 'skipped', reason: 'unresolved provider' })
      continue
    }
    const model = primary.slice(primary.indexOf('/') + 1)
    const identity = raw?.identity && typeof raw.identity === 'object' ? raw.identity : {}
    const agent: any = {
      id: entry.id,
      name: stringOf(raw?.name) || entry.id,
      description: stringOf(raw?.description) || `Imported from OpenClaw agent "${entry.id}"`,
      instructions: stringOf(raw?.instructions ?? raw?.system_prompt) || '',
      provider: { id: providerId, model },
      identity: {
        name: stringOf(identity.name) || stringOf(raw?.name) || entry.id,
        theme: stringOf(identity.theme),
        emoji: stringOf(identity.emoji),
        avatar: stringOf(identity.avatar),
      },
      default: raw?.default === true,
      workspace: stringOf(raw?.workspace),
    }
    if (options.dryRun) {
      summary.agents.push({ id: entry.id, action: 'planned' })
      continue
    }
    try {
      await upsertAgent(agent, { failIfExists: !options.overwrite })
      summary.agents.push({ id: entry.id, action: options.overwrite ? 'updated' : 'created' })
    } catch (error: any) {
      summary.agents.push({ id: entry.id, action: 'skipped', reason: error?.message ?? String(error) })
    }
  }
}

function parseProviderId(modelRef: string | undefined): string {
  if (!modelRef || typeof modelRef !== 'string') return ''
  const head = modelRef.split('/')[0]
  return normalizeProviderId(head)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
