import { stdout } from 'node:process'

const useColor = stdout.isTTY && process.env.NO_COLOR == null
const c = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)

export const color = {
  bold: (s) => c('1', s),
  dim: (s) => c('2', s),
  cyan: (s) => c('36', s),
  green: (s) => c('32', s),
  yellow: (s) => c('33', s),
  magenta: (s) => c('35', s),
  blue: (s) => c('34', s),
  gray: (s) => c('90', s),
}

export const GROUPS = [
  {
    title: 'Getting started',
    commands: ['setup', 'status', 'doctor'],
  },
  {
    title: 'Chat & run',
    commands: ['chat', 'run', 'resume'],
  },
  {
    title: 'Agents',
    commands: ['agents', 'sessions', 'undo'],
  },
  {
    title: 'Providers',
    commands: ['provider'],
  },
  {
    title: 'Memory',
    commands: ['memory'],
  },
  {
    title: 'Automation',
    commands: ['schedule', 'routine', 'reactive'],
  },
  {
    title: 'Hub & server',
    commands: ['hub'],
  },
  {
    title: 'Tools & plugins',
    commands: ['tools', 'plugins', 'mcp'],
  },
  {
    title: 'Settings',
    commands: ['settings'],
  },
]

function pad(text, width) {
  if (text.length >= width) return text
  return text + ' '.repeat(width - text.length)
}

function formatAliases(cmd) {
  const aliases = cmd.aliases?.() ?? []
  if (!aliases.length) return ''
  return color.dim(` (${aliases.join(', ')})`)
}

export function formatHelp(program) {
  const allCommands = program.commands.filter((cmd) => !cmd._hidden && cmd.name() !== 'help')
  const byName = new Map(allCommands.map((cmd) => [cmd.name(), cmd]))
  const grouped = new Set()

  const lines = []
  lines.push('')
  lines.push(color.bold(color.cyan('  ⚒  lannr')) + color.dim(`  v${program.version()}`))
  lines.push(color.dim(`     ${program.description()}`))
  lines.push('')
  lines.push(color.bold('Usage'))
  lines.push(`  ${color.cyan('lannr')} ${color.dim('[command]')} ${color.dim('[options]')}`)
  lines.push('')

  const nameWidth = Math.max(...allCommands.map((cmd) => cmd.name().length + (cmd.aliases?.().length ? cmd.aliases().join(', ').length + 3 : 0))) + 2

  for (const group of GROUPS) {
  const groupCmds = group.commands.map((name) => byName.get(name)).filter(Boolean) as any[]
    if (!groupCmds.length) continue
    lines.push(color.bold(group.title))
    for (const cmd of groupCmds) {
      grouped.add(cmd.name())
      const label = `${color.cyan(cmd.name())}${formatAliases(cmd)}`
      const visibleLen = cmd.name().length + (cmd.aliases?.().length ? cmd.aliases().join(', ').length + 3 : 0)
      const padding = ' '.repeat(Math.max(0, nameWidth - visibleLen))
      lines.push(`  ${label}${padding}${color.dim(cmd.description())}`)
    }
    lines.push('')
  }

  const ungrouped = allCommands.filter((cmd) => !grouped.has(cmd.name())) as any[]
  if (ungrouped.length) {
    lines.push(color.bold('Other'))
    for (const cmd of ungrouped) {
      const label = `${color.cyan(cmd.name())}${formatAliases(cmd)}`
      lines.push(`  ${pad(label, nameWidth)}${color.dim(cmd.description())}`)
    }
    lines.push('')
  }

  lines.push(color.bold('Examples'))
  lines.push(`  ${color.dim('$')} ${color.cyan('lannr setup')}                ${color.dim('# first-time configuration')}`)
  lines.push(`  ${color.dim('$')} ${color.cyan('lannr chat')}                 ${color.dim('# open the terminal UI')}`)
  lines.push(`  ${color.dim('$')} ${color.cyan('lannr run')} ${color.yellow('"summarize foo.md"')}  ${color.dim('# one-shot prompt')}`)
  lines.push(`  ${color.dim('$')} ${color.cyan('lannr agents add')} ${color.yellow('writer openai')}  ${color.dim('# create an agent')}`)
  lines.push('')
  lines.push(color.dim(`Run ${color.cyan('lannr <command> --help')}${color.dim(' to see options for a specific command.')}`))
  lines.push('')

  return lines.join('\n')
}

function applyHelpConfig(cmd, program) {
  cmd.helpOption('-h, --help', 'show help')
  cmd.addHelpCommand(false)
  cmd.configureHelp({
    formatHelp: (c, helper) => {
      if (c === program) return formatHelp(program)
      return formatSubcommandHelp(c, helper)
    },
  })
  for (const sub of cmd.commands) applyHelpConfig(sub, program)
}

export function attachHelp(program) {
  applyHelpConfig(program, program)
}

function formatSubcommandHelp(cmd, helper) {
  const lines = []
  const fullName = helper.commandUsage(cmd)
  lines.push('')
  lines.push(`${color.bold(color.cyan(cmd.name()))}  ${color.dim(cmd.description())}`)
  lines.push('')
  lines.push(color.bold('Usage'))
  lines.push(`  ${color.cyan(fullName)}`)
  lines.push('')

  const aliases = cmd.aliases?.() ?? []
  if (aliases.length) {
    lines.push(color.bold('Aliases'))
    lines.push(`  ${aliases.map((a) => color.cyan(a)).join(', ')}`)
    lines.push('')
  }

  const args = helper.visibleArguments(cmd)
  if (args.length) {
    lines.push(color.bold('Arguments'))
    const w = Math.max(...args.map((a) => helper.argumentTerm(a).length)) + 2
    for (const arg of args) {
      lines.push(`  ${color.yellow(pad(helper.argumentTerm(arg), w))}${color.dim(helper.argumentDescription(arg))}`)
    }
    lines.push('')
  }

  const opts = helper.visibleOptions(cmd)
  if (opts.length) {
    lines.push(color.bold('Options'))
    const w = Math.max(...opts.map((o) => helper.optionTerm(o).length)) + 2
    for (const opt of opts) {
      lines.push(`  ${color.green(pad(helper.optionTerm(opt), w))}${color.dim(helper.optionDescription(opt))}`)
    }
    lines.push('')
  }

  const subs = helper.visibleCommands(cmd)
  if (subs.length) {
    lines.push(color.bold('Subcommands'))
    const w = Math.max(...subs.map((s) => helper.subcommandTerm(s).length)) + 2
    for (const sub of subs) {
      lines.push(`  ${color.cyan(pad(helper.subcommandTerm(sub), w))}${color.dim(sub.description())}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
