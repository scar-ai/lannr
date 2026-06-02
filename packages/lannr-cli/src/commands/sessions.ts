import { loadConfig } from '../config.js'
import { listSessions } from '../agents/sessions.js'
import { printTable } from '../cli/helpers.js'

function resolveAgent(agents, key) {
  if (!key) return null
  const direct = agents[key]
  if (direct) return direct
  const lower = String(key).toLowerCase()
  return Object.values(agents).find((entry) => (
    entry.id === key ||
    entry.name?.toLowerCase() === lower ||
    entry.aliases?.includes(key)
  )) ?? null
}

export function register(program) {
  const sessions = program.command('sessions').description('Inspect saved chat sessions')

  sessions.command('list')
    .alias('ls')
    .description('List saved sessions for one or all agents')
    .option('--agent <id>', 'restrict to a single agent (id, name, or alias)')
    .option('--json', 'print JSON')
    .action(async (opts) => {
      const config = await loadConfig()
      let targets
      if (opts.agent) {
        const agent = resolveAgent(config.agents, opts.agent)
        if (!agent) {
          console.error(`Agent not found: ${opts.agent}`)
          process.exitCode = 1
          return
        }
        targets = [agent]
      } else {
        targets = Object.values(config.agents)
      }

      const rows = []
      for (const agent of targets) {
        const items = await listSessions(agent)
        for (const item of items) {
          rows.push({
            agent: agent.id,
            id: item.id,
            title: item.title,
            messages: item.messageCount,
            updatedAt: item.updatedAt,
          })
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }

      if (rows.length === 0) {
        console.log(opts.agent
          ? `No sessions for agent "${opts.agent}".`
          : 'No saved sessions.')
        return
      }

      rows.sort((a, b) => {
        const at = a.updatedAt ? Date.parse(a.updatedAt) : 0
        const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0
        return bt - at
      })

      printTable(rows.map((row) => ({
        agent: row.agent,
        id: row.id,
        title: row.title.length > 60 ? `${row.title.slice(0, 57)}…` : row.title,
        messages: row.messages,
        updated: row.updatedAt ?? '',
      })))
    })
}
