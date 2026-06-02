import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { removeOpenAICodexAuth } from './openai-codex-auth.js'

export const DEFAULT_PROVIDER_ID = 'default'

interface RegistryOptions {
  root?: string
  path?: string
  failIfExists?: boolean
}

interface ProviderConfig {
  id: string
  name?: string
  type?: string
  baseURL?: string
  baseUrl?: string
  base_url?: string
  apiKey?: string
  api_key?: string
  apiKeyEnv?: string
  api_key_env?: string
  endpoint?: string
  defaultModel?: string
  default_model?: string
  model?: string
  models?: unknown
  promptCache?: unknown
  prompt_cache?: unknown
  unsupportedReason?: string
  unsupported_reason?: string
  aliases?: unknown
}

interface ProviderRegistry {
  providers: ProviderConfig[]
  primaryProviderId?: string
  primary_provider_id?: string
}

export function providerRegistryPath({ root }: RegistryOptions = {}) {
  return resolve(root ?? homedir(), '.lannr/providers.json')
}

export function defaultProviderDir(providerId: string, { root }: RegistryOptions = {}) {
  return resolve(root ?? homedir(), '.lannr', 'providers', normalizeProviderId(providerId))
}

export async function listProviders(options = {}) {
  const registry = await readRegistry(options)
  return registry.providers.map((provider) => ({
    ...provider,
    primary: provider.id === registry.primaryProviderId,
  }))
}

export async function getProvider(id, options = {}) {
  const registry = await readRegistry(options)
  return buildProviderMaps(registry.providers).aliases.get(normalizeProviderId(id))
}

export async function upsertProvider(provider, options: RegistryOptions = {}) {
  const registry = await readRegistry(options)
  const normalized = normalizeProvider(provider)
  const exists = registry.providers.some((entry) => normalizeProviderId(entry.id) === normalized.id)
  if (exists && options.failIfExists) {
    throw new Error(`Provider "${normalized.id}" already exists.`)
  }
  assertNoProviderAliasCollision(normalized, registry.providers)
  const providers = registry.providers.filter((entry) => normalizeProviderId(entry.id) !== normalized.id)
  providers.push(normalized)
  providers.sort((left, right) => left.id.localeCompare(right.id))
  await writeRegistry({ providers, primaryProviderId: registry.primaryProviderId }, options)
  return normalized
}

function assertNoProviderAliasCollision(incoming, providers) {
  const taken = new Map()
  for (const other of providers) {
    const id = normalizeProviderId(other.id)
    if (id === incoming.id) continue
    taken.set(id, id)
    for (const alias of other.aliases ?? []) taken.set(normalizeProviderId(alias), id)
  }
  const incomingKeys = [incoming.id, ...(incoming.aliases ?? []).map(normalizeProviderId)].filter(Boolean)
  for (const key of incomingKeys) {
    if (taken.has(key)) {
      throw new Error(`Provider name or alias "${key}" is already used by "${taken.get(key)}".`)
    }
  }
}

export async function removeProvider(id, options: RegistryOptions = {}) {
  const registry = await readRegistry(options)
  const normalized = normalizeProviderId(id)
  const maps = buildProviderMaps(registry.providers)
  const existing = maps.aliases.get(normalized)
  if (!existing) return null
  const providers = registry.providers.filter((entry) => normalizeProviderId(entry.id) !== existing.id)
  const primaryProviderId = registry.primaryProviderId === existing.id ? undefined : registry.primaryProviderId
  await writeRegistry({ providers, primaryProviderId }, options)
  await removeProviderState(existing, options)
  return existing
}

export async function getPrimaryProvider(options: RegistryOptions = {}) {
  const registry = await readRegistry(options)
  if (!registry.primaryProviderId) return null
  return buildProviderMaps(registry.providers).aliases.get(registry.primaryProviderId) ?? null
}

export async function setPrimaryProvider(id, options: RegistryOptions = {}) {
  const registry = await readRegistry(options)
  const provider = buildProviderMaps(registry.providers).aliases.get(normalizeProviderId(id))
  if (!provider) return null
  await writeRegistry({ providers: registry.providers, primaryProviderId: provider.id }, options)
  return provider
}

export async function addProviderModels(id, models, options: RegistryOptions = {}) {
  const registry = await readRegistry(options)
  const existing = buildProviderMaps(registry.providers).aliases.get(normalizeProviderId(id))
  if (!existing) return null
  const provider = normalizeProvider({
    ...existing,
    models: [...existing.models, ...arrayOfStrings(models)],
  })
  await replaceProvider(registry, provider, options)
  return provider
}

export async function removeProviderModels(id, models, options: RegistryOptions = {}) {
  const registry = await readRegistry(options)
  const existing = buildProviderMaps(registry.providers).aliases.get(normalizeProviderId(id))
  if (!existing) return null
  const removeSet = new Set(arrayOfStrings(models))
  const provider = normalizeProvider({
    ...existing,
    models: existing.models.filter((model) => !removeSet.has(model)),
    defaultModel: removeSet.has(existing.defaultModel) ? undefined : existing.defaultModel,
  })
  await replaceProvider(registry, provider, options)
  return provider
}

export async function setProviderDefaultModel(id, model, options: RegistryOptions = {}) {
  const registry = await readRegistry(options)
  const existing = buildProviderMaps(registry.providers).aliases.get(normalizeProviderId(id))
  if (!existing) return null
  const provider = normalizeProvider({
    ...existing,
    defaultModel: model,
    models: [...existing.models, model],
  })
  await replaceProvider(registry, provider, options)
  return provider
}

export async function readRegistry(options: RegistryOptions = {}) {
  try {
    const raw = await readFile(options.path ?? providerRegistryPath(options), 'utf8')
    return normalizeRegistry(JSON.parse(raw))
  } catch (error) {
    if (error?.code === 'ENOENT') return { providers: [], primaryProviderId: undefined }
    throw error
  }
}

export function buildProviderMaps(providers) {
  const canonical = new Map()
  const aliases = new Map()

  for (const provider of providers) {
    const normalized = normalizeProvider(provider)
    canonical.set(normalized.id, normalized)
    aliases.set(normalized.id, normalized)
    for (const alias of normalized.aliases) {
      aliases.set(normalizeProviderId(alias), normalized)
    }
  }

  return { canonical, aliases }
}

export function normalizeProviderId(value) {
  return String(value ?? '').trim().toLowerCase()
}

function normalizeRegistry(value) {
  const providers = Array.isArray(value?.providers) ? value.providers : []
  const normalizedProviders = providers.map(normalizeProvider).filter((provider) => provider.id)
  const primaryProviderId = normalizeProviderId(value?.primaryProviderId ?? value?.primary_provider_id)
  const hasPrimary = primaryProviderId && normalizedProviders.some((provider) => provider.id === primaryProviderId)
  return {
    providers: normalizedProviders,
    primaryProviderId: hasPrimary ? primaryProviderId : undefined,
  }
}

function normalizeProvider(value) {
  const id = normalizeProviderId(value.id)
  if (!id) throw new Error('Provider id is required')
  const models = uniqueStrings([
    ...arrayOfStrings(value.models),
    ...arrayOfStrings(value.model),
    ...arrayOfStrings(value.defaultModel),
    ...arrayOfStrings(value.default_model),
  ])
  const defaultModel = stringOr(value.defaultModel, value.default_model, value.model, models[0])
  return {
    id,
    name: stringOr(value.name, id),
    type: stringOr(value.type, 'openai-compatible'),
    baseURL: stringOr(value.baseURL, value.baseUrl, value.base_url),
    apiKey: stringOr(value.apiKey, value.api_key),
    apiKeyEnv: stringOr(value.apiKeyEnv, value.api_key_env),
    endpoint: stringOr(value.endpoint, 'chat-completions'),
    defaultModel,
    models: uniqueStrings([defaultModel, ...models]),
    promptCache: normalizePromptCache(value.promptCache ?? value.prompt_cache),
    unsupportedReason: stringOr(value.unsupportedReason, value.unsupported_reason),
    aliases: arrayOfStrings(value.aliases),
  }
}

async function replaceProvider(registry: ProviderRegistry, provider: ProviderConfig, options: RegistryOptions = {}) {
  const providers = registry.providers.filter((entry) => normalizeProviderId(entry.id) !== provider.id)
  providers.push(provider)
  providers.sort((left, right) => left.id.localeCompare(right.id))
  await writeRegistry({ providers, primaryProviderId: registry.primaryProviderId }, options)
}

async function writeRegistry(registry: ProviderRegistry, options: RegistryOptions = {}) {
  const path = options.path ?? providerRegistryPath(options)
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(normalizeRegistry(registry), null, 2)}\n`)
  await rename(tempPath, path)
}

async function removeProviderState(provider: ProviderConfig, options: RegistryOptions = {}) {
  await rm(defaultProviderDir(provider.id, options), { recursive: true, force: true })
  if (provider.id === 'openai-codex') {
    await removeOpenAICodexAuth(options)
  }
}

function stringOr(...values) {
  const value = values.find((item) => typeof item === 'string' && item.trim().length > 0)
  return value?.trim()
}

function arrayOfStrings(value) {
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean)
  if (Array.isArray(value)) return value.flatMap(arrayOfStrings)
  return []
}

function uniqueStrings(values) {
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))]
}

function normalizePromptCache(value) {
  if (value === true) return true
  if (value === false || value == null || value === '') return undefined
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (!normalized || ['false', 'off', 'disabled', 'none'].includes(normalized)) return undefined
    if (['true', 'on', 'enabled', '5m'].includes(normalized)) return normalized === '5m' ? { ttl: '5m' } : true
    if (normalized === '1h') return { ttl: '1h' }
    throw new Error('promptCache must be true, false, 5m, 1h, or an object with ttl.')
  }
  if (typeof value === 'object') {
    const ttl = stringOr(value.ttl)
    if (ttl && !['5m', '1h'].includes(ttl)) throw new Error('promptCache.ttl must be 5m or 1h.')
    return {
      ...(stringOr(value.type) ? { type: stringOr(value.type) } : {}),
      ...(ttl ? { ttl } : {}),
    }
  }
  return undefined
}
