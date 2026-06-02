import {
  loadAgentMemorySnapshot,
  memoryEntryPath,
  memoryUsage,
  readMemoryEntries,
  scanMemoryContent,
  writeMemoryEntries,
} from '../agents/tools/memory.js'
import { resolveMemoryCommandRuntime } from '../cli/helpers.js'

const TARGET_LABEL = { memory: 'MEMORY.md', user: 'USER.md' }

function parseTarget(opts) {
  return opts.user ? 'user' : 'memory'
}

function printEntries(target, entries) {
  const label = TARGET_LABEL[target]
  if (entries.length === 0) {
    console.log(`${label}: no entries.`)
    return
  }
  console.log(`${label} (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}):`)
  entries.forEach((entry, index) => {
    const lines = entry.split('\n')
    console.log(`  ${index + 1}. ${lines[0]}`)
    for (const line of lines.slice(1)) console.log(`     ${line}`)
  })
}

function printUsage(target, usage) {
  const detail = usage.limit > 0 ? `${usage.chars}/${usage.limit} chars (${usage.percent}%)` : `${usage.chars} chars`
  console.log(`  usage: ${detail}`)
}

async function loadEntries(agent, target) {
  const entries = await readMemoryEntries(agent, target)
  return { entries, usage: memoryUsage(target, entries) }
}

export function register(program) {
  const memory = program.command('memory')
    .description('Curated notes the agent carries across sessions (USER.md + MEMORY.md)')

  memory.command('list')
    .alias('ls')
    .description('Show saved memory entries')
    .argument('<agent>', 'agent id, name, or alias')
    .option('--user', 'show USER.md instead of MEMORY.md')
    .option('--all', 'show both files')
    .option('--json', 'print JSON')
    .action(async (agentId, opts) => {
      const { agent } = await resolveMemoryCommandRuntime(agentId)
      const snapshot = await loadAgentMemorySnapshot(agent)
      if (opts.json) {
        console.log(JSON.stringify({
          agent: agent.id,
          memory: { entries: snapshot.memory, usage: memoryUsage('memory', snapshot.memory) },
          user: { entries: snapshot.user, usage: memoryUsage('user', snapshot.user) },
        }, null, 2))
        return
      }
      if (opts.all || !opts.user) {
        printEntries('memory', snapshot.memory)
        printUsage('memory', memoryUsage('memory', snapshot.memory))
      }
      if (opts.all || opts.user) {
        printEntries('user', snapshot.user)
        printUsage('user', memoryUsage('user', snapshot.user))
      }
    })

  memory.command('add')
    .description('Append a new entry')
    .argument('<agent>', 'agent id, name, or alias')
    .argument('<text>', 'entry text')
    .option('--user', 'write to USER.md instead of MEMORY.md')
    .action(async (agentId, text, opts) => {
      const { agent } = await resolveMemoryCommandRuntime(agentId)
      const target = parseTarget(opts)
      const blocked = scanMemoryContent(text)
      if (blocked) {
        console.error(`Blocked: ${blocked}`)
        process.exitCode = 1
        return
      }
      const { entries } = await loadEntries(agent, target)
      const trimmed = text.trim()
      if (entries.includes(trimmed)) {
        console.log('Duplicate entry; nothing changed.')
        return
      }
      const next = [...entries, trimmed]
      await writeMemoryEntries(agent, target, next)
      console.log(`Added to ${TARGET_LABEL[target]} (${next.length} entries).`)
    })

  memory.command('replace')
    .description('Find an entry by substring and replace it')
    .argument('<agent>', 'agent id, name, or alias')
    .argument('<old>', 'unique substring of the existing entry')
    .argument('<new>', 'replacement text')
    .option('--user', 'edit USER.md instead of MEMORY.md')
    .action(async (agentId, oldText, newText, opts) => {
      const { agent } = await resolveMemoryCommandRuntime(agentId)
      const target = parseTarget(opts)
      const blocked = scanMemoryContent(newText)
      if (blocked) {
        console.error(`Blocked: ${blocked}`)
        process.exitCode = 1
        return
      }
      const { entries } = await loadEntries(agent, target)
      const matches = entries.filter((entry) => entry.includes(oldText))
      if (matches.length === 0) {
        console.error(`No entry matched: ${oldText}`)
        process.exitCode = 1
        return
      }
      if (matches.length > 1) {
        console.error(`${matches.length} entries matched; use a more unique substring.`)
        process.exitCode = 1
        return
      }
      const next = entries.map((entry) => (entry === matches[0] ? newText.trim() : entry))
      await writeMemoryEntries(agent, target, next)
      console.log(`Replaced entry in ${TARGET_LABEL[target]}.`)
    })

  memory.command('remove')
    .alias('rm')
    .description('Find an entry by substring and delete it')
    .argument('<agent>', 'agent id, name, or alias')
    .argument('<text>', 'unique substring of the entry to remove')
    .option('--user', 'edit USER.md instead of MEMORY.md')
    .action(async (agentId, text, opts) => {
      const { agent } = await resolveMemoryCommandRuntime(agentId)
      const target = parseTarget(opts)
      const { entries } = await loadEntries(agent, target)
      const matches = entries.filter((entry) => entry.includes(text))
      if (matches.length === 0) {
        console.error(`No entry matched: ${text}`)
        process.exitCode = 1
        return
      }
      if (matches.length > 1) {
        console.error(`${matches.length} entries matched; use a more unique substring.`)
        process.exitCode = 1
        return
      }
      const next = entries.filter((entry) => entry !== matches[0])
      await writeMemoryEntries(agent, target, next)
      console.log(`Removed entry from ${TARGET_LABEL[target]} (${next.length} entries remain).`)
    })

  memory.command('show')
    .description('Print the raw memory file')
    .argument('<agent>', 'agent id, name, or alias')
    .option('--user', 'show USER.md instead of MEMORY.md')
    .action(async (agentId, opts) => {
      const { agent } = await resolveMemoryCommandRuntime(agentId)
      const target = parseTarget(opts)
      const { entries } = await loadEntries(agent, target)
      if (entries.length === 0) {
        console.log(`${TARGET_LABEL[target]} is empty.`)
        return
      }
      console.log(entries.join('\n---\n'))
    })

  memory.command('path')
    .description('Print the on-disk path of the memory file')
    .argument('<agent>', 'agent id, name, or alias')
    .option('--user', 'print USER.md path instead of MEMORY.md')
    .action(async (agentId, opts) => {
      const { agent } = await resolveMemoryCommandRuntime(agentId)
      console.log(memoryEntryPath(agent, parseTarget(opts)))
    })
}
