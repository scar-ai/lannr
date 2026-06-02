import React from 'react'
import { render } from 'ink'
import { agentRegistryPath, listAgents, removeAgent, updateAgent } from '../agents/registry.js'
import { listSkills, parseSkillList } from '../agents/skills.js'
import { listProviders } from '../providers/registry.js'
import { AgentEditor } from '../ui/AgentEditor.js'
import {
  addAgentCommand,
  collect,
  mutateBindings,
  printTable,
  prompt,
  resolveAgentFromList,
  setIdentityCommand,
} from '../cli/helpers.js'

export function register(program) {
  const agents = program.command('agents').description('Manage agents')

  agents.command('ls')
    .alias('list')
    .description('List registered agents')
    .option('--json', 'print JSON')
    .option('--bindings', 'include routing bindings')
    .action(async (opts) => {
      const rows = await listAgents()
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }
      if (rows.length === 0) {
        console.log(`No agents registered. Registry: ${agentRegistryPath()}`)
        return
      }
      printTable(rows.map((agent) => ({
        id: agent.id,
        name: agent.name,
        workspace: agent.workspace,
        deniedSkills: agent.deniedSkills?.join(',') ?? '',
        globalReach: agent.globalReach ? 'yes' : '',
        agentDir: agent.agentDir,
        provider: agent.providerConfig?.model ? `${agent.provider}:${agent.providerConfig.model}` : agent.provider,
        default: agent.default ? 'yes' : '',
        bindings: opts.bindings ? JSON.stringify(agent.bindings ?? []) : (agent.bindings?.length ?? 0),
      })))
    })

  agents.command('add')
    .aliases(['new', 'create'])
    .description('Add a new isolated agent (provider is required)')
    .argument('<name>', 'agent name')
    .argument('<provider>', 'provider id or alias (required)')
    .option('--description <text>', 'agent description')
    .option('--instructions <text>', 'agent operating instructions')
    .option('--workspace <path>', 'agent workspace path')
    .option('--agent-dir <path>', 'agent state directory')
    .option('--alias <alias>', 'alias for this agent; can be repeated', collect, [])
    .option('--bind <route>', 'routing binding; can be repeated', collect, [])
    .option('--denyskills <skills>', 'comma-separated skill names this agent cannot use; can be repeated', collect, [])
    .option('--globalreach', 'allow this agent to access files outside its workspace')
    .option('--default', 'make this the default agent')
    .option('--non-interactive', 'disable prompts; defaults workspace to ~/.lannr/agents/<agent-id>/workspace')
    .option('--json', 'output JSON summary')
    .option('--overwrite-workspace-files', 'rewrite generated workspace markdown files')
    .action(async (name, provider, opts) => {
      await addAgentCommand(name, { ...opts, provider })
    })

  agents.command('edit')
    .description('Edit an agent in an interactive UI')
    .argument('[name]', 'agent id, name, or alias')
    .action(async (name) => {
      const agentList = await listAgents()
      if (agentList.length === 0) {
        console.error(`No agents registered. Registry: ${agentRegistryPath()}`)
        process.exitCode = 1
        return
      }
      const id = name ?? await prompt('Agent to edit: ')
      const agent = resolveAgentFromList(agentList, id)
      if (!agent) {
        console.error(`Agent not found: ${id}`)
        process.exitCode = 1
        return
      }
      if (!process.stdin.isTTY) {
        console.error('lannr agents edit requires an interactive terminal.')
        process.exitCode = 1
        return
      }
      const [providers, skills] = await Promise.all([listProviders(), listSkills()])
      let saved = null
      const { waitUntilExit } = render(
        React.createElement(AgentEditor, {
          agent,
          providers,
          skills,
          onSave: async (patch) => { saved = await updateAgent(agent.id, patch) },
        }),
        { exitOnCtrlC: true },
      )
      await waitUntilExit()
      if (saved) console.log(`Agent "${saved.name}" updated in ${agentRegistryPath()}`)
    })

  agents.command('update')
    .alias('set')
    .description('Update an agent without opening the interactive editor')
    .argument('<name>', 'agent id, name, or alias')
    .option('--name <name>', 'agent display name')
    .option('--description <text>', 'agent description')
    .option('--instructions <text>', 'agent operating instructions')
    .option('--provider <id>', 'provider id or alias')
    .option('--model <model>', 'provider model override')
    .option('--alias <alias>', 'replace aliases; can be repeated', collect, [])
    .option('--bind <route>', 'replace routing bindings; can be repeated', collect, [])
    .option('--denyskills <skills>', 'replace denied skills; comma-separated and repeatable', collect, [])
    .option('--globalreach', 'allow this agent to access files outside its workspace')
    .option('--no-globalreach', 'disable access outside this agent workspace')
    .option('--default', 'make this the default agent')
    .option('--json', 'output JSON summary')
    .action(async (name, opts) => {
      const patch: any = {}
      if (opts.name !== undefined) patch.name = opts.name
      if (opts.description !== undefined) patch.description = opts.description
      if (opts.instructions !== undefined) patch.instructions = opts.instructions
      if (opts.alias?.length) patch.aliases = opts.alias
      if (opts.bind?.length) patch.bindings = opts.bind.map((route) => ({ route }))
      if (opts.denyskills?.length) patch.deniedSkills = parseSkillList(opts.denyskills)
      if (opts.globalreach !== undefined) patch.globalReach = opts.globalreach
      if (opts.default) patch.default = true
      if (opts.provider !== undefined || opts.model !== undefined) {
        const agents = await listAgents()
        const existing = resolveAgentFromList(agents, name)
        if (!existing) {
          console.error(`Agent not found: ${name}`)
          process.exitCode = 1
          return
        }
        patch.providerConfig = {
          ...(existing.providerConfig ?? { id: existing.provider ?? 'default' }),
          ...(opts.provider !== undefined ? { id: opts.provider } : {}),
          ...(opts.model !== undefined ? { model: opts.model } : {}),
        }
      }
      if (Object.keys(patch).length === 0) {
        console.error('No updates provided.')
        process.exitCode = 1
        return
      }
      const saved = await updateAgent(name, patch)
      if (!saved) {
        console.error(`Agent not found: ${name}`)
        process.exitCode = 1
        return
      }
      if (opts.json) console.log(JSON.stringify(saved, null, 2))
      else console.log(`Agent "${saved.id}" updated in ${agentRegistryPath()}`)
    })

  agents.command('bindings')
    .description('List routing bindings')
    .option('--agent <id>', 'filter by agent id')
    .option('--json', 'output JSON')
    .action(async (opts) => {
      const rows = (await listAgents())
        .filter((agent) => !opts.agent || agent.id === opts.agent)
        .flatMap((agent) => (agent.bindings ?? []).map((binding) => ({ agent: agent.id, ...binding })))
      if (opts.json) console.log(JSON.stringify(rows, null, 2))
      else if (rows.length) printTable(rows)
      else console.log('No bindings configured.')
    })

  agents.command('bind')
    .description('Add routing bindings for an agent')
    .option('--agent <id>', 'agent id')
    .option('--bind <route>', 'binding to add; repeatable', collect, [])
    .option('--json', 'output JSON summary')
    .action(async (opts) => {
      const result = await mutateBindings(opts.agent, opts.bind, 'add')
      if (opts.json) console.log(JSON.stringify(result, null, 2))
      else console.log(`Added ${result.added.length} binding(s) to ${result.agent.id}.`)
    })

  agents.command('unbind')
    .description('Remove routing bindings for an agent')
    .option('--agent <id>', 'agent id')
    .option('--bind <route>', 'binding to remove; repeatable', collect, [])
    .option('--all', 'remove all bindings')
    .option('--json', 'output JSON summary')
    .action(async (opts) => {
      const result = await mutateBindings(opts.agent, opts.bind, opts.all ? 'clear' : 'remove')
      if (opts.json) console.log(JSON.stringify(result, null, 2))
      else console.log(`Updated ${result.agent.id}; ${result.agent.bindings.length} binding(s) remain.`)
    })

  agents.command('set-identity')
    .description('Update an agent identity')
    .option('--agent <id>', 'agent id to update')
    .option('--workspace <dir>', 'workspace directory used to locate agent and IDENTITY.md')
    .option('--identity-file <path>', 'explicit IDENTITY.md path to read')
    .option('--from-identity', 'read values from IDENTITY.md')
    .option('--name <name>', 'identity name')
    .option('--theme <theme>', 'identity theme')
    .option('--emoji <emoji>', 'identity emoji')
    .option('--avatar <value>', 'identity avatar')
    .option('--json', 'output JSON summary')
    .action(async (opts) => {
      const saved = await setIdentityCommand(opts)
      if (!saved) {
        console.error('Agent not found. Pass --agent or --workspace.')
        process.exitCode = 1
        return
      }
      if (opts.json) console.log(JSON.stringify(saved, null, 2))
      else console.log(`Identity updated for "${saved.id}".`)
    })

  agents.command('rm')
    .alias('remove')
    .alias('delete')
    .description('Remove an agent')
    .argument('[id]', 'agent id, name, or alias')
    .action(async (id) => {
      const agentId = id ?? await prompt('Agent id to remove: ')
      const removed = await removeAgent(agentId)
      if (!removed) {
        console.error(`Agent not found: ${agentId}`)
        process.exitCode = 1
        return
      }
      console.log(`Agent "${removed.name}" removed from ${agentRegistryPath()}`)
    })
}
