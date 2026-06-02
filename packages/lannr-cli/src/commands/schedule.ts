import { getRoutineStatus } from 'lannr-extras/scheduler'
import { normalizeTriggerInput } from '../scheduler/duration.js'
import { normalizeScheduleId } from '../agents/scheduling.js'
import { formatTrigger, printTable, resolveConfigAgent, resolveSchedulerCommandRuntime } from '../cli/helpers.js'
import { loadConfig } from '../config.js'
import { agentSchedulerDir, createAgentReactiveRoutineStore } from '../scheduler/store.js'
import { executeScheduledAction } from '../scheduler/manager.js'

function truncate(value, limit) {
  const text = String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function describe(row) {
  if (row.description) return row.description
  if (row.agentTurn?.prompt) return row.agentTurn.prompt
  return row.routineId ?? ''
}

export function register(program) {
  const recurrent = program.command('schedule')
    .alias('recurrent')
    .alias('recur')
    .description('Schedule recurring or one-off agent actions (cron, every, run-at)')

  recurrent.command('ls')
    .alias('list')
    .description('List scheduled recurring or one-time actions for all agents, or one agent with --agent')
    .option('-a, --agent <agent>', 'agent id, name, or alias to filter by')
    .option('--json', 'print JSON')
    .option('--all', 'include disabled entries')
    .action(async (opts) => {
      const groups = await listScheduleGroups(opts.agent)
      const groupsWithRows = groups.map(({ agent, schedulerDir, rows }) => ({
        agent,
        schedulerDir,
        rows: opts.all ? rows : rows.filter((row) => row.enabled),
      }))
      if (opts.json) {
        const nowIso = new Date()
        console.log(JSON.stringify({
          agents: groupsWithRows.map(({ agent, schedulerDir, rows }) => ({
            agent: agent.id,
            schedulerDir,
            actions: rows.map((row) => ({ ...row, status: getRoutineStatus(row, nowIso) })),
          })),
        }, null, 2))
        return
      }
      const total = groupsWithRows.reduce((sum, group) => sum + group.rows.length, 0)
      if (total === 0) {
        const scope = opts.agent ? ` for agent ${groupsWithRows[0]?.agent.id ?? opts.agent}` : ''
        console.log(opts.all ? `No scheduled actions${scope}.` : `No active scheduled actions${scope}. Use --all to include disabled.`)
        return
      }
      const now = new Date()
      printTable(groupsWithRows.flatMap(({ agent, rows }) => rows.map((row) => ({
        agent: agent.id,
        id: row.id,
        status: getRoutineStatus(row, now),
        kind: row.agentTurn ? 'agent-turn' : 'routine',
        trigger: formatTrigger(row.trigger),
        description: truncate(describe(row), 60),
        runningSince: row.runningSince?.toISOString?.() ?? row.runningSince ?? '',
        nextRunAt: row.nextRunAt?.toISOString?.() ?? row.nextRunAt ?? '',
        lastStatus: row.lastRunStatus ?? '',
      }))))
    })

  recurrent.command('show')
    .description('Show full details of a scheduled action')
    .argument('<id>', 'scheduled action id')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .action(async (id, opts) => {
      const { store } = await resolveSchedulerCommandRuntime(opts.agent)
      const row = await store.get(id)
      if (!row) {
        console.error(`Not found: ${id}`)
        process.exitCode = 1
        return
      }
      const results = await store.results(id)
      console.log(JSON.stringify({ action: row, recentRuns: results.slice(-5) }, null, 2))
    })

  recurrent.command('add')
    .description('Schedule an agent turn from the CLI (mirrors what the agent\'s scheduleAgentTurn tool does)')
    .requiredOption('-d, --description <text>', 'short description shown in `recurrent ls`')
    .requiredOption('-m, --prompt <text>', 'prompt the agent will receive when the action fires')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .option('--every <duration>', 'recurring duration, e.g. 10m, 1h30m, 2h')
    .option('--in <duration>', 'one-shot offset, e.g. 5m, 2h')
    .option('--run-at <iso>', 'one-shot ISO timestamp')
    .option('--cron <expr>', 'five-field cron expression')
    .option('--name <id>', 'explicit id; default derived from description')
    .option('--failure-threshold <n>', 'disable after this many consecutive failures', '5')
    .action(async (opts) => {
      const { agent, store } = await resolveSchedulerCommandRuntime(opts.agent)
      const { trigger, nextRunAt } = normalizeTriggerInput({
        every: opts.every,
        in: opts.in,
        runAt: opts.runAt,
        cron: opts.cron,
      })
      const id = normalizeScheduleId(opts.name ?? opts.description.slice(0, 32))
      const reactive = {
        id,
        name: id,
        description: opts.description.trim(),
        routineId: `agent-turn:${id}`,
        agentTurn: { prompt: opts.prompt, agentId: agent.id },
        trigger,
        input: {},
        sink: { type: 'store' },
        enabled: true,
        lastRunAt: null,
        lastRunStatus: null,
        consecutiveFailures: 0,
        failureThreshold: Number(opts.failureThreshold) || 5,
        nextRunAt,
        catchUp: false,
        createdAt: new Date(),
      }
      await store.save(reactive)
      console.log(JSON.stringify({
        id,
        agent: agent.id,
        trigger,
        nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
      }, null, 2))
    })

  recurrent.command('rm')
    .alias('delete')
    .description('Remove a scheduled action')
    .argument('<id>', 'scheduled action id')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .action(async (id, opts) => {
      const { store } = await resolveSchedulerCommandRuntime(opts.agent)
      await store.delete(id)
      console.log(`Removed ${id}`)
    })

  recurrent.command('disable')
    .description('Disable a scheduled action')
    .argument('<id>', 'scheduled action id')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .action(async (id, opts) => {
      const { store } = await resolveSchedulerCommandRuntime(opts.agent)
      await store.disable(id)
      console.log(`Disabled ${id}`)
    })

  recurrent.command('enable')
    .description('Enable a scheduled action')
    .argument('<id>', 'scheduled action id')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .action(async (id, opts) => {
      const { store } = await resolveSchedulerCommandRuntime(opts.agent)
      await store.enable(id)
      console.log(`Enabled ${id}`)
    })

  recurrent.command('run')
    .description('Run a scheduled action once, immediately, without changing its schedule')
    .argument('<id>', 'scheduled action id')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .action(async (id, opts) => {
      const { runtime, store } = await resolveSchedulerCommandRuntime(opts.agent)
      const reactive = await store.get(id)
      if (!reactive) {
        console.error(`Not found: ${id}`)
        process.exitCode = 1
        return
      }
      try {
        await store.markRunning(id)
        const result = await executeScheduledAction(runtime, reactive, undefined)
        await store.recordSuccess(id, result)
        console.log(JSON.stringify({ id, result }, null, 2))
      } catch (error) {
        await store.recordFailure(id, error)
        throw error
      }
    })
}

async function listScheduleGroups(agentId) {
  const config = await loadConfig()
  const agents = agentId ? [resolveConfigAgent(config, agentId)] : Object.values(config.agents)
  return Promise.all(agents.map(async (agent) => {
    const store = createAgentReactiveRoutineStore(agent)
    return {
      agent,
      schedulerDir: agentSchedulerDir(agent),
      rows: await store.list(),
    }
  }))
}
