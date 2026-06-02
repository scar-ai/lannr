import { runTui } from '../tui.js'

export function register(program) {
  program.command('chat')
    .aliases(['tui', 'terminal'])
    .description('Open the interactive Lannr terminal UI')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .option('-p, --provider <provider>', 'provider override for this session')
    .option('-m, --model <model>', 'model override for this session')
    .option('--session <key>', 'session id to open')
    .option('--message <text>', 'send an initial message after opening')
    .option('--history-limit <n>', 'messages to keep in the TUI session', '200')
    .option('--no-tools', 'hide tool execution events')
    .option('--thinking', 'show raw Lannr thinking/program output', false)
    .action(async (opts) => {
      await runTui(opts)
    })
}
