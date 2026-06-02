import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { loadConfig } from '../config.js'
import { agentRegistryPath, listAgents } from '../agents/registry.js'
import { providerRegistryPath, listProviders } from '../providers/registry.js'
import { openAICodexAuthPath } from '../providers/openai-codex-auth.js'
import { printTable, uniqueById } from '../cli/helpers.js'

export async function ensureLannrHome() {
  await mkdir(dirname(agentRegistryPath()), { recursive: true })
}

export async function runDoctorChecks() {
  // Inspect the real registries, not loadConfig() — it fabricates synthetic
  // "default" provider/agent entries when nothing is registered, which would
  // make a brand-new install look already configured.
  const [registeredProviders, registeredAgents] = await Promise.all([listProviders(), listAgents()])
  const issues = []
  const providers = uniqueById(registeredProviders as any[])
  const agents = uniqueById(registeredAgents as any[])
  const providerIds = new Set(providers.map((provider) => provider.id))
  if (providers.length === 0) issues.push('No providers configured.')
  for (const provider of providers) {
    if (!provider.defaultModel) issues.push(`Provider "${provider.id}" has no default model.`)
    if (provider.id === 'openai-codex') continue
    if (!provider.apiKey && provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) {
      issues.push(`Provider "${provider.id}" expects missing env var ${provider.apiKeyEnv}.`)
    }
  }
  if (agents.length === 0) issues.push('No agents configured.')
  for (const agent of agents) {
    if (!providerIds.has(agent.provider) && agent.provider !== 'default') {
      issues.push(`Agent "${agent.id}" references missing provider "${agent.provider}".`)
    }
  }
  return { issues, providerCount: providers.length, agentCount: agents.length }
}

export function register(program) {
  program.command('status')
    .description('Show Lannr local runtime status')
    .option('--json', 'print JSON')
    .action(async (opts) => {
      const config = await loadConfig()
      const status = {
        providerRegistry: providerRegistryPath(),
        agentRegistry: agentRegistryPath(),
        defaultAgentId: config.defaultAgentId,
        primaryProviderId: config.primaryProviderId,
        providers: uniqueById(Object.values(config.providers)).map((provider) => ({
          id: provider.id,
          type: provider.type,
          model: provider.defaultModel,
          auth: provider.id === 'openai-codex' ? `oauth:${openAICodexAuthPath()}` : provider.apiKey ? 'configured' : provider.apiKeyEnv ? `env:${provider.apiKeyEnv}` : 'missing',
        })),
        agents: uniqueById(Object.values(config.agents)).map((agent) => ({
          id: agent.id,
          name: agent.name,
          provider: agent.provider,
          workspace: agent.workspace,
          default: agent.id === config.defaultAgentId,
        })),
      }
      if (opts.json) {
        console.log(JSON.stringify(status, null, 2))
        return
      }
      console.log(`Default agent: ${status.defaultAgentId}`)
      console.log(`Primary provider: ${status.primaryProviderId}`)
      console.log(`Agent registry: ${status.agentRegistry}`)
      console.log(`Provider registry: ${status.providerRegistry}`)
      printTable(status.providers)
      printTable(status.agents)
    })

  program.command('doctor')
    .description('Check the local Lannr setup')
    .action(async () => {
      await ensureLannrHome()
      const { issues } = await runDoctorChecks()
      if (issues.length === 0) {
        console.log('Lannr setup looks usable.')
        return
      }
      for (const issue of issues) console.log(`- ${issue}`)
      process.exitCode = 1
    })
}
