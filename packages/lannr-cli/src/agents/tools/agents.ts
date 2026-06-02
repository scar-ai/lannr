import { tool } from 'lannr-core'
import { z } from 'zod'
import { listAgents } from '../registry.js'
import { buildSpawnPrompt, selectSpawnAgent } from '../selection.js'
import { decrementSpawnDepth, getSpawnDepth, incrementSpawnDepth } from '../spawn-state.js'

export function createAgentTools(ctx) {
  const { agent } = ctx
  return [
    tool({
      name: 'listAgents',
      description: 'List other user-created Lannr agents available in this installation, including their ids, names, descriptions, providers, workspaces, aliases, and default status.',
      input: z.object({
        includeSelf: z.boolean().default(true),
      }).default({}),
      output: z.array(z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        provider: z.string(),
        workspace: z.string(),
        globalReach: z.boolean(),
        default: z.boolean(),
        aliases: z.array(z.string()),
        createdAt: z.string(),
        updatedAt: z.string(),
        self: z.boolean(),
      })),
      handler: async ({ includeSelf = true } = {}) => {
        const agents = await listAgents()
        return agents
          .filter((entry) => includeSelf || entry.id !== agent.id)
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            description: entry.description,
            provider: entry.provider,
            workspace: entry.workspace,
            globalReach: Boolean(entry.globalReach),
            default: Boolean(entry.default),
            aliases: entry.aliases ?? [],
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            self: entry.id === agent.id,
          }))
      },
    }),
    tool({
      name: 'spawnAgent',
      description: [
        'Spawn one specialized user-created Lannr agent for a focused task and return its final answer.',
        'If agent is omitted, Lannr selects the best available agent by matching the task against agent names, aliases, descriptions, and instructions.',
        'Use this for specialized work where another configured agent is a better fit. Pass all relevant context because the spawned agent does not inherit this conversation.',
      ].join(' '),
      input: z.object({
        task: z.string().min(1),
        context: z.string().default(''),
        agent: z.string().optional(),
      }),
      output: z.object({
        agent: z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          provider: z.string(),
          workspace: z.string(),
          globalReach: z.boolean(),
          aliases: z.array(z.string()),
        }),
        selectedBy: z.enum(['requested', 'description-match']),
        answer: z.string(),
      }),
      handler: async ({ task, context = '', agent: requestedAgent }) => {
        if (getSpawnDepth() >= 1) throw new Error('spawnAgent cannot be called from a spawned agent.')

        const agents = await listAgents()
        const selected = selectSpawnAgent(agents, {
          currentAgentId: agent.id,
          requestedAgent,
          task,
          context,
        })
        if (!selected.agent) throw new Error(selected.error ?? 'No suitable agent found.')

        const prompt = buildSpawnPrompt({
          parent: agent,
          child: selected.agent,
          task,
          context,
        })
        const { createLannrGateway } = await import('../../gateway.js')
        const gateway = await createLannrGateway()

        incrementSpawnDepth()
        try {
          const completion = await gateway.complete({
            agent: selected.agent.id,
            messages: [{ role: 'user', content: prompt }],
          })
          return {
            agent: {
              id: selected.agent.id,
              name: selected.agent.name,
              description: selected.agent.description,
              provider: selected.agent.provider,
              workspace: selected.agent.workspace,
              globalReach: Boolean(selected.agent.globalReach),
              aliases: selected.agent.aliases ?? [],
            },
            selectedBy: selected.selectedBy,
            answer: completion.choices?.[0]?.message?.content ?? '',
          }
        } finally {
          decrementSpawnDepth()
        }
      },
    }),
  ]
}
