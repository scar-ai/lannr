import { getPrimaryProvider, listProviders } from './providers/registry.js'
import { defaultAgentDir, defaultAgentWorkspace, listAgents, resolveDefaultAgent } from './agents/registry.js'

export type CliProviderConfig = {
  id: string
  name?: string
  type?: string
  baseURL?: string
  apiKey?: string
  apiKeyEnv?: string
  endpoint?: string
  defaultModel?: string
  models?: string[]
  aliases?: string[]
  primary?: boolean
  unsupportedReason?: string
}

export type CliAgentConfig = {
  id: string
  name: string
  description?: string
  instructions?: string
  workspace: string
  agentDir: string
  sessionsDir: string
  provider: string
  providerConfig?: { id: string, model?: string, params?: Record<string, any> }
  model?: string
  identity?: Record<string, any>
  bindings: Array<Record<string, any>>
  aliases: string[]
  deniedSkills: string[]
  globalReach: boolean
  default?: boolean
  createdAt?: string
  updatedAt?: string
}

export type CliConfig = {
  port: number
  host: string
  providers: Record<string, CliProviderConfig>
  agents: Record<string, CliAgentConfig>
  defaultAgentId: string
  primaryProviderId: string
}

type ConfigOverrides = Record<string, any>

export async function loadConfig(overrides: ConfigOverrides = {}): Promise<CliConfig> {
  const port = numberFrom(overrides.port, process.env.LANNR_HUB_PORT, 8787)
  const host = stringFrom(overrides.host, process.env.LANNR_HUB_HOST, '127.0.0.1')
  const model = stringFrom(overrides.model, process.env.LANNR_MODEL, 'lannr-default')
  const baseURL = stringFrom(overrides.baseURL, process.env.LANNR_BASE_URL, 'http://127.0.0.1:11434/v1')
  const apiKey = stringFrom(overrides.apiKey, process.env.LANNR_API_KEY, process.env.OPENAI_API_KEY, 'lannr-local')
  const endpoint = stringFrom(overrides.endpoint, process.env.LANNR_OPENAI_ENDPOINT, 'chat-completions')
  const registeredProviders = await listProviders()
  const primaryProvider = await getPrimaryProvider()
  const registeredAgents = await listAgents()
  const providers: Record<string, CliProviderConfig> = Object.fromEntries(registeredProviders.map((provider: any) => [
    provider.id,
    {
      ...provider,
      apiKey: resolveProviderApiKey(provider),
    },
  ]))
  providers.default ??= {
    id: 'default',
    name: 'Default',
    type: 'openai-compatible',
    baseURL,
    apiKey,
    endpoint,
    defaultModel: model,
    aliases: [],
  }
  if (primaryProvider) {
    providers.default = {
      ...primaryProvider,
      apiKey: resolveProviderApiKey(primaryProvider),
      aliases: [...new Set([...(primaryProvider.aliases ?? []), 'default'])],
    }
  }

  const defaultAgent = resolveDefaultAgent(registeredAgents)
  const agents: Record<string, CliAgentConfig> = Object.fromEntries(registeredAgents.map((agent: any) => [agent.id, agent]))
  if (!defaultAgent) {
    agents.default = {
      id: 'default',
      name: 'Default',
      description: 'Default Lannr agent',
      instructions: '',
      workspace: defaultAgentWorkspace('default'),
      agentDir: defaultAgentDir('default'),
      sessionsDir: `${defaultAgentDir('default')}/sessions`,
      provider: 'default',
      model,
      identity: { name: 'Default' },
      bindings: [],
      aliases: [],
      deniedSkills: [],
      globalReach: false,
      default: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  return {
    port,
    host,
    providers,
    agents,
    defaultAgentId: defaultAgent?.id ?? 'default',
    primaryProviderId: primaryProvider?.id ?? providers.default.id,
  }
}

function resolveProviderApiKey(provider) {
  if (provider.apiKey) return provider.apiKey
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return process.env[provider.apiKeyEnv]
  return undefined
}

function stringFrom(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0)
}

function numberFrom(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 8787
}
