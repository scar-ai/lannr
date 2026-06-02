import { runAgentPrompt } from '../agents/runtime.js'
import { readStdinOrPrompt } from '../cli/helpers.js'
import { runTui } from '../tui.js'

export function register(program) {
  program.command('run')
    .description('Run a one-shot prompt with a Lannr agent')
    .argument('[prompt...]', 'prompt text')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .option('-p, --provider <provider>', 'provider override for this run')
    .option('-m, --model <model>', 'model override for this run')
    .option('--session <id>', 'session id to save this run under')
    .action(async (promptParts, opts) => {
      const promptText = promptParts.join(' ').trim() || await readStdinOrPrompt('Prompt: ')
      await runAgentPrompt({
        agentId: opts.agent,
        prompt: promptText,
        session: opts.session,
        stream: true,
        overrides: { provider: opts.provider, model: opts.model },
      })
    })

  program.command('resume')
    .description('Resume a saved Lannr chat session')
    .argument('<session>', 'session id')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .option('-p, --provider <provider>', 'provider override for this session')
    .option('-m, --model <model>', 'model override for this session')
    .option('--message <text>', 'send an initial message after opening')
    .option('--history-limit <n>', 'messages to keep in the TUI session', '200')
    .option('--no-tools', 'hide tool execution events')
    .option('--thinking', 'show raw Lannr thinking/program output', false)
    .action(async (session, opts) => {
      await runTui({
        ...opts,
        session,
      })
    })
}
