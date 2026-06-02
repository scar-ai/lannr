import { resolve } from 'node:path'
import { buildPromptCacheKey, createLannr } from 'lannr-core'
import { nodeRunner } from 'lannr-core/runner-node'
import { createModelAdapter } from '../llm/model-adapter.js'
import { loadConfig } from '../config.js'
import { getMaxIterations } from '../settings.js'
import { loadToolConfig } from '../tools/web.js'
import { agentMemoryDir, createAgentMemoryStore } from './memory.js'
import { buildAgentSystemPrompt, buildPerTurnContext } from './prompt.js'
import { listSkills } from './skills.js'
import { createWorkspaceTools } from './tools/index.js'
import type { CliAgentConfig, CliConfig, CliProviderConfig } from '../config.js'

export { agentMemoryDir, createAgentMemoryStore }

type RuntimeOverrides = Record<string, any>

export async function runAgentPrompt({ agentId, prompt, session, stream = false, overrides = {} }: Record<string, any>) {
  const { createLannrGateway } = await import('../gateway.js')
  const gateway = await createLannrGateway(overrides)
  const request = {
    agent: agentId,
    provider: overrides.provider,
    model: overrides.model,
    session,
    messages: [{ role: 'user', content: prompt }],
  }

  if (!stream) return gateway.complete(request)

  let final = null
  let wroteOutput = false
  for await (const event of gateway.streamEvents(request, (result) => { final = result })) {
    if (event.type === 'lannr:answer:delta') {
      process.stdout.write(event.text)
      wroteOutput = true
    }
    if (event.type === 'lannr:answer' && event.text && !wroteOutput) {
      process.stdout.write(`${event.text}\n`)
      wroteOutput = true
    }
    if (event.type === 'lannr:tool:call') process.stderr.write(`[tool] ${event.tool}\n`)
    if (event.type === 'lannr:tool:error') process.stderr.write(`[tool:error] ${event.tool}: ${event.error}\n`)
  }
  if (wroteOutput) process.stdout.write('\n')
  return final
}

export async function createAgentRuntime({ agentId, overrides = {} }: { agentId?: string, overrides?: RuntimeOverrides } = {}) {
  const config = await loadConfig(overrides)
  const agent = resolveAgent(config, agentId)
  const provider = resolveProvider(config, agent, overrides.provider)
  const model = overrides.model ?? agent.providerConfig?.model ?? agent.model ?? provider.defaultModel
  const workspace = resolve(agent.workspace)
  const promptCacheKey = buildPromptCacheKey({ namespace: 'lannr', agentId: agent.id, threadId: overrides.session })
  const systemPrompt = await buildAgentSystemPrompt(agent, workspace)
  const perTurnContext = await buildPerTurnContext(agent, workspace)
  const memory = createAgentMemoryStore(agent)
  const toolConfig = await loadToolConfig()
  const readOnlyRoots = await skillReadOnlyRoots(agent)

  const ctx = {
    workspace,
    agent,
    memory,
    toolConfig,
    readOnlyRoots,
    globalReach: Boolean(agent.globalReach),
    checkpoint: overrides.checkpoint ?? null,
    session: overrides.session ?? null,
  }

  const tools = await createWorkspaceTools(ctx)
  const maxIterations = overrides.maxIterations ?? await getMaxIterations()
  return {
    agent,
    provider,
    model,
    workspace,
    systemPrompt,
    perTurnContext,
    promptCacheKey,
    memory,
    ctx,
    lannr: createLannr({
      runner: nodeRunner({ timeoutMs: 30_000, memoryLimitMb: 128 }),
      model: createModelAdapter(provider, model),
      tools,
      memory,
      promptCacheKey,
      maxIterations,
    }),
  }
}

async function skillReadOnlyRoots(agent: CliAgentConfig) {
  const skills = await listSkills({ agent, deniedSkills: agent?.deniedSkills ?? [] })
  return skills.map((skill) => resolve(skill.baseDir))
}

function resolveAgent(config: CliConfig, agentId?: string): CliAgentConfig {
  const key = agentId ?? config.defaultAgentId ?? 'default'
  const agent = config.agents[key] ?? Object.values(config.agents).find((entry) => {
    return entry.id === key || entry.name?.toLowerCase() === String(key).toLowerCase() || entry.aliases?.includes(key)
  })
  if (!agent) throw new Error(`Agent not found: ${key}`)
  return agent
}

function resolveProvider(config: CliConfig, agent: CliAgentConfig, providerOverride?: string): CliProviderConfig {
  const providerId = providerOverride ?? agent.provider
  const provider = config.providers[providerId] ?? Object.values(config.providers).find((entry) => {
    return entry.id === providerId || (entry.aliases ?? []).includes(providerId)
  }) ?? config.providers.default
  if (!provider) throw new Error(`Provider not found for agent "${agent.name}": ${providerId}`)
  return {
    ...provider,
    apiKey: provider.apiKey || (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined),
  }
}
