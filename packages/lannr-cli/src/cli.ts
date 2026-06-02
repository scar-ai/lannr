#!/usr/bin/env node
import { Command } from 'commander'
import { printHome } from './cli/helpers.js'
import { attachHelp } from './cli/help.js'
import { register as registerSetup } from './commands/setup.js'
import { register as registerRun } from './commands/run.js'
import { register as registerTui } from './commands/tui.js'
import { register as registerStatus } from './commands/status.js'
import { register as registerHub } from './commands/hub.js'
import { register as registerMemory } from './commands/memory.js'
import { register as registerRoutine } from './commands/routine.js'
import { register as registerReactive } from './commands/reactive.js'
import { register as registerSchedule } from './commands/schedule.js'
import { register as registerProvider } from './commands/provider.js'
import { register as registerAgents } from './commands/agents.js'
import { register as registerSkills } from './commands/skills.js'
import { register as registerUndo } from './commands/undo.js'
import { register as registerPlugins } from './commands/plugins.js'
import { register as registerMcp } from './commands/mcp.js'
import { register as registerSettings } from './commands/settings.js'
import { register as registerSessions } from './commands/sessions.js'
import { register as registerImport } from './commands/import.js'
import { getCliVersion } from './version.js'

const program = new Command()

program.name('lannr').description('Lannr agentic platform CLI').version(getCliVersion())
program.showHelpAfterError()

program.action(async () => {
  await printHome()
})

registerSetup(program)
registerRun(program)
registerTui(program)
registerStatus(program)
registerHub(program)
registerMemory(program)
registerRoutine(program)
registerReactive(program)
registerSchedule(program)
registerProvider(program)
registerAgents(program)
registerSkills(program)
registerUndo(program)
registerPlugins(program)
registerMcp(program)
registerSettings(program)
registerSessions(program)
registerImport(program)

attachHelp(program)

const parseKeepAlive = setInterval(() => {}, 60_000)
program.parseAsync()
  .catch((error) => {
    console.error(error?.message ?? error)
    process.exitCode = 1
  })
  .finally(() => {
    clearInterval(parseKeepAlive)
  })
