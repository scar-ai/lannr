import { rollbackRoutine } from 'lannr-extras/memory'
import { agentMemoryDir, createAgentRuntime } from '../agents/runtime.js'
import { parseJsonOption, printTable, resolveMemoryCommandRuntime, validateTrustLevel } from '../cli/helpers.js'

export function register(program) {
  const routine = program.command('routine')
    .description('Saved Lannr routines — typed programs the agent can replay')

  routine.command('list')
    .alias('ls')
    .description('List saved routines')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .option('--min-trust <level>', 'minimum trust: draft|provisional|trusted|pinned', 'draft')
    .option('--json', 'print JSON')
    .action(async (opts) => {
      validateTrustLevel(opts.minTrust)
      const { agent, store } = await resolveMemoryCommandRuntime(opts.agent)
      const rows = await store.list({ minTrust: opts.minTrust })
      if (opts.json) {
        console.log(JSON.stringify({ agent: agent.id, memoryDir: agentMemoryDir(agent), routines: rows }, null, 2))
        return
      }
      console.log(`Agent: ${agent.id}`)
      console.log(`Routines dir: ${agentMemoryDir(agent)}`)
      if (rows.length === 0) {
        console.log('No routines saved.')
        return
      }
      printTable(rows.map((row) => ({
        id: row.id,
        name: row.name,
        trust: row.trust?.level,
        runs: row.trust?.runs,
        success: row.trust?.successRate,
        tags: row.tags?.join(',') ?? '',
        description: row.description,
      })))
    })

  routine.command('show')
    .alias('inspect')
    .description('Show a saved routine in full')
    .argument('<routine-id>', 'routine id')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .action(async (id, opts) => {
      const { store } = await resolveMemoryCommandRuntime(opts.agent)
      const row = await store.get(id)
      if (!row) {
        console.error(`Routine not found: ${id}`)
        process.exitCode = 1
        return
      }
      console.log(JSON.stringify(row, null, 2))
    })

  routine.command('rollback')
    .description('Roll back a routine to an earlier version')
    .argument('<routine-id>', 'routine id')
    .requiredOption('--to-version <version>', 'target version number')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .action(async (id, opts) => {
      const { store } = await resolveMemoryCommandRuntime(opts.agent)
      const row = await rollbackRoutine(store, id, Number(opts.toVersion))
      console.log(JSON.stringify(row, null, 2))
    })

  routine.command('run')
    .description('Run a saved routine by id or name')
    .argument('<routine>', 'routine id or name')
    .requiredOption('--input <json>', 'JSON input passed to the routine')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .action(async (routineRef, opts) => {
      const runtime = await createAgentRuntime({ agentId: opts.agent })
      const summaries = await runtime.memory.list({ minTrust: 'draft' })
      const summary = summaries.find((entry) => entry.id === routineRef || entry.name === routineRef)
      if (!summary) {
        console.error(`Routine not found: ${routineRef}`)
        process.exitCode = 1
        return
      }
      const saved = await runtime.memory.get(summary.id)
      if (!saved) {
        console.error(`Routine not found: ${routineRef}`)
        process.exitCode = 1
        return
      }
      const result = await runtime.lannr.runRoutine(saved, parseJsonOption(opts.input, '--input'))
      console.log(JSON.stringify({ agent: runtime.agent.id, routine: summary.id, result }, null, 2))
    })
}
