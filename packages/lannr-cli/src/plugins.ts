import { buildProviderMaps } from './providers/registry.js'
import { buildAgentMaps } from './agents/registry.js'

export async function registerPlugins({ config }) {
  const providerMaps = buildProviderMaps(Object.values(config.providers))
  const agentMaps = buildAgentMaps(Object.values(config.agents))
  return {
    agents: agentMaps.aliases,
    defaultAgentId: config.defaultAgentId,
    providers: providerMaps.aliases,
  }
}
