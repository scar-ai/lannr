import { loadConfig } from '../config.js'
import { printTable, resolveConfigAgent } from '../cli/helpers.js'
import { createCheckpointManager } from '../safety/checkpoint.js'

export function register(program) {
  program.command('undo')
    .description('Restore the workspace to the state before the last agent turn')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .option('--turn <id>', 'restore a specific checkpoint id')
    .option('--list', 'list available checkpoints')
    .option('--json', 'print JSON')
    .action(async (opts) => {
      const config = await loadConfig()
      const agent = resolveConfigAgent(config, opts.agent)
      const manager = createCheckpointManager(agent)

      if (opts.list) {
        const entries = await manager.list()
        if (opts.json) { console.log(JSON.stringify(entries, null, 2)); return }
        if (!entries.length) { console.log(`No checkpoints recorded for agent ${agent.id}.`); return }
        printTable(entries.map((entry) => ({
          turnId: entry.turnId,
          createdAt: entry.createdAt,
          files: entry.fileCount,
        })))
        return
      }

      const turnId = opts.turn ?? (await manager.list())[0]?.turnId
      if (!turnId) {
        console.error(`No checkpoints available for agent ${agent.id}.`)
        process.exitCode = 1
        return
      }
      const result = await manager.restore(turnId)
      if (opts.json) {
        console.log(JSON.stringify({ turnId, restored: result.restored, removed: result.removed }, null, 2))
        return
      }
      console.log(`Restored ${result.restored} file(s) from checkpoint ${turnId}.`)
      if (result.removed.length) console.log(`Removed ${result.removed.length} file(s) created after the checkpoint.`)
    })
}
