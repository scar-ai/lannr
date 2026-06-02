import { readFile, stat } from 'node:fs/promises'
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
import { parseDotenv, parseYamlMini } from './yaml-mini.js'

export interface ImportOptions {
  source?: string
  overwrite?: boolean
  dryRun?: boolean
  includeSecrets?: boolean
  setPrimary?: boolean
  json?: boolean
}

export interface ImportSummary {
  source: string
  hermesRoot: string
  providers: ProviderResult[]
  agents: AgentResult[]
  primaryProvider?: string
  notes: string[]
}

interface ProviderResult {
  id: string
  action: 'created' | 'updated' | 'skipped' | 'planned'
  reason?: string
}

interface AgentResult {
  id: string
  action: 'created' | 'updated' | 'skipped' | 'planned'
  reason?: string
}

const HERMES_PROVIDER_MAP: Record<string, string> = {
  auto: 'openrouter',
  nous: 'openrouter',
  'nous-api': 'openrouter',
  copilot: 'openrouter',
  'azure-foundry': 'microsoft-foundry',
  'kimi-coding': 'kimi-coding',
  'minimax-cn': 'minimax',
  'ollama-cloud': 'ollama',
  gemini: 'google',
  custom: 'lmstudio',
}

export async function importFromHermes(
  what: 'all' | 'providers' | 'agents',
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const hermesRoot = resolve(options.source || join(homedir(), '.hermes'))
  const summary: ImportSummary = {
    source: 'hermes',
    hermesRoot,
    providers: [],
    agents: [],
    notes: [],
  }

  const config = await readHermesConfig(hermesRoot, summary)
  const env = await readHermesEnv(hermesRoot)

  const wantProviders = what === 'all' || what === 'providers'
  const wantAgents = what === 'all' || what === 'agents'

  if (wantProviders) {
    await importHermesProviders(config, env, options, summary)
  }
  if (wantAgents) {
    await importHermesAgent(config, options, summary)
  }

  return summary
}

async function readHermesConfig(root: string, summary: ImportSummary): Promise<any> {
  const path = join(root, 'config.yaml')
  try {
    const raw = await readFile(path, 'utf8')
    return parseYamlMini(raw)
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      summary.notes.push(`No config.yaml at ${path} — using defaults.`)
      return {}
    }
    throw error
  }
}

async function readHermesEnv(root: string): Promise<Record<string, string>> {
  const path = join(root, '.env')
  try {
    const raw = await readFile(path, 'utf8')
    return parseDotenv(raw)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
}

async function importHermesProviders(
  config: any,
  env: Record<string, string>,
  options: ImportOptions,
  summary: ImportSummary,
): Promise<void> {
  const model = (config?.model && typeof config.model === 'object') ? config.model : {}
  const defaultModel = stringOf(model.default ?? model.model)
  const providerHint = stringOf(model.provider)
  const baseUrl = stringOf(model.base_url ?? model.baseUrl)
  const apiKey = stringOf(model.api_key ?? model.apiKey)

  const primaryProviderId = resolveHermesProviderId(providerHint, defaultModel)
  const seen = new Set<string>()

  if (primaryProviderId) {
    await upsertOne(primaryProviderId, {
      baseUrl,
      apiKey: options.includeSecrets ? apiKey : undefined,
      defaultModel: stripModelPrefix(defaultModel, primaryProviderId),
    }, env, options, summary)
    seen.add(primaryProviderId)
  }

  const providers = (model.providers && typeof model.providers === 'object') ? model.providers : {}
  for (const [rawId, raw] of Object.entries(providers)) {
    const cfg = (raw && typeof raw === 'object') ? (raw as any) : {}
    const id = resolveHermesProviderId(rawId, undefined)
    if (!id || seen.has(id)) continue
    await upsertOne(id, {
      baseUrl: stringOf(cfg.base_url ?? cfg.baseUrl),
      apiKey: options.includeSecrets ? stringOf(cfg.api_key ?? cfg.apiKey) : undefined,
      defaultModel: undefined,
    }, env, options, summary)
    seen.add(id)
  }

  if (options.setPrimary !== false && primaryProviderId && !options.dryRun) {
    const saved = await setPrimaryProvider(primaryProviderId)
    if (saved) summary.primaryProvider = saved.id
  } else if (primaryProviderId) {
    summary.primaryProvider = primaryProviderId
  }
}

async function upsertOne(
  id: string,
  overrides: { baseUrl?: string; apiKey?: string; defaultModel?: string },
  env: Record<string, string>,
  options: ImportOptions,
  summary: ImportSummary,
): Promise<void> {
  const preset = getOpenClawProviderPreset(id) || {}
  const apiKeyEnv = preset.apiKeyEnv
  const inlineKey = overrides.apiKey ?? (apiKeyEnv && options.includeSecrets ? env[apiKeyEnv] : undefined)

  const payload: any = {
    id,
    name: preset.name || id,
    type: preset.type || 'openai-compatible',
    baseURL: overrides.baseUrl || preset.baseURL,
    endpoint: preset.endpoint || 'chat-completions',
    defaultModel: overrides.defaultModel || preset.defaultModel,
    apiKeyEnv,
    apiKey: inlineKey,
  }

  const existing = (await listProviders()).find((p) => p.id === normalizeProviderId(id))
  if (existing && !options.overwrite) {
    summary.providers.push({ id, action: 'skipped', reason: 'already exists (use --overwrite)' })
    return
  }
  if (options.dryRun) {
    summary.providers.push({ id, action: 'planned' })
    return
  }
  try {
    const saved = await upsertProvider(payload)
    summary.providers.push({ id: saved.id, action: existing ? 'updated' : 'created' })
  } catch (error: any) {
    summary.providers.push({ id, action: 'skipped', reason: error?.message ?? String(error) })
  }
}

async function importHermesAgent(
  config: any,
  options: ImportOptions,
  summary: ImportSummary,
): Promise<void> {
  const model = (config?.model && typeof config.model === 'object') ? config.model : {}
  const defaultModel = stringOf(model.default ?? model.model)
  const providerHint = stringOf(model.provider)
  const providerId = resolveHermesProviderId(providerHint, defaultModel)
  if (!providerId) {
    summary.notes.push('No model/provider configured in hermes — skipping agent import.')
    return
  }

  const soul = await tryReadMarkdown(join(summary.hermesRoot, 'SOUL.md'))
  const instructions = await tryReadMarkdown(join(summary.hermesRoot, 'AGENTS.md'))
  const agentId = 'hermes'
  const agent = {
    id: agentId,
    name: 'Hermes',
    description: soul ? soul.split('\n')[0]?.slice(0, 200) : 'Imported from Hermes',
    instructions: instructions ?? soul ?? '',
    provider: { id: providerId, model: stripModelPrefix(defaultModel, providerId) },
  }

  if (options.dryRun) {
    summary.agents.push({ id: agentId, action: 'planned' })
    return
  }

  try {
    await upsertAgent(agent, { failIfExists: !options.overwrite })
    summary.agents.push({ id: agentId, action: options.overwrite ? 'updated' : 'created' })
  } catch (error: any) {
    summary.agents.push({ id: agentId, action: 'skipped', reason: error?.message ?? String(error) })
  }
}

async function tryReadMarkdown(path: string): Promise<string | undefined> {
  try {
    await stat(path)
    return (await readFile(path, 'utf8')).trim()
  } catch {
    return undefined
  }
}

function resolveHermesProviderId(hint: string | undefined, modelRef: string | undefined): string {
  if (hint && hint !== 'auto') {
    const mapped = HERMES_PROVIDER_MAP[hint] ?? hint
    return normalizeProviderId(mapped)
  }
  if (modelRef && modelRef.includes('/')) {
    const head = modelRef.split('/')[0]
    return normalizeProviderId(HERMES_PROVIDER_MAP[head] ?? head)
  }
  return ''
}

function stripModelPrefix(modelRef: string | undefined, providerId: string): string | undefined {
  if (!modelRef) return undefined
  if (modelRef.includes('/')) {
    const [head, ...rest] = modelRef.split('/')
    if (normalizeProviderId(head) === providerId) return rest.join('/')
  }
  return modelRef
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
