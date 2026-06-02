import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tool } from 'lannr-core'
import { z } from 'zod'

const ENTRY_DELIMITER = '\n§\n'
const TARGETS = ['memory', 'user']
const LIMITS = { memory: 2200, user: 1375 }

const INVISIBLE_CHARS = new Set(['​', '‌', '‍', '⁠', '﻿', '‪', '‫', '‬', '‭', '‮'])
const THREAT_PATTERNS = [
  /ignore\s+(previous|all|above|prior)\s+instructions/i,
  /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i,
  /system\s+prompt\s+override/i,
  /authorized_keys/i,
  /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
]

export function memoryEntriesDir(agent) {
  return resolve(agent.agentDir, 'memory', 'entries')
}

export function memoryEntryPath(agent, target) {
  return join(memoryEntriesDir(agent), target === 'user' ? 'USER.md' : 'MEMORY.md')
}

export async function readMemoryEntries(agent, target) {
  try {
    const raw = await readFile(memoryEntryPath(agent, target), 'utf8')
    return [...new Set(raw.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean))]
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export async function writeMemoryEntries(agent, target, entries) {
  await mkdir(memoryEntriesDir(agent), { recursive: true })
  const path = memoryEntryPath(agent, target)
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, entries.join(ENTRY_DELIMITER))
  await rename(tmp, path)
}

export function memoryUsage(target, entries) {
  const limit = LIMITS[target] ?? 0
  const chars = entries.join(ENTRY_DELIMITER).length
  const percent = limit > 0 ? Math.min(100, Math.floor((chars / limit) * 100)) : 0
  return { chars, limit, percent }
}

export function scanMemoryContent(content) {
  for (const ch of content) {
    if (INVISIBLE_CHARS.has(ch)) return `content contains invisible unicode character U+${ch.codePointAt(0).toString(16).padStart(4, '0')}`
  }
  for (const pattern of THREAT_PATTERNS) {
    if (pattern.test(content)) return `content matches threat pattern ${pattern}`
  }
  return null
}

export async function loadAgentMemorySnapshot(agent) {
  const [memory, user] = await Promise.all([readMemoryEntries(agent, 'memory'), readMemoryEntries(agent, 'user')])
  return { memory, user, dir: memoryEntriesDir(agent) }
}

export function renderMemoryForPrompt({ memory, user }) {
  const sections = []
  if (user.length) sections.push(`USER PROFILE (durable):\n${user.join('\n---\n')}`)
  if (memory.length) sections.push(`AGENT MEMORY (durable):\n${memory.join('\n---\n')}`)
  return sections.length ? sections.join('\n\n') : ''
}

export const MEMORY_TARGETS = TARGETS
export const MEMORY_LIMITS = LIMITS

export function createMemoryTools(ctx) {
  const { agent } = ctx

  return [
    tool({
      name: 'memory',
      description: [
        'Persistent notes that survive across sessions. Two stores:',
        "  target='user'   — durable facts about the person (name, role, preferences, communication style)",
        "  target='memory' — your own notes (project conventions, environment quirks, lessons learned)",
        'Actions: read | add | replace | remove.',
        'When to use: save a fact the moment you learn it; do not wait until end-of-turn.',
        'When NOT to use: ephemeral task state, secrets, large dumps, things easily re-derived from code.',
        'For replace/remove, old_text is a unique substring of the existing entry.',
        'Returns the full entry list after every mutation so you can confirm the write.',
      ].join('\n'),
      input: z.object({
        action: z.enum(['read', 'add', 'replace', 'remove']).default('read'),
        target: z.enum(['memory', 'user']).default('memory'),
        content: z.string().optional(),
        old_text: z.string().optional(),
      }),
      output: z.object({
        success: z.boolean(),
        target: z.string(),
        entries: z.array(z.string()),
        usage: z.object({ chars: z.number(), limit: z.number(), percent: z.number() }),
        message: z.string().optional(),
        error: z.string().optional(),
      }),
      handler: async ({ action = 'read', target = 'memory', content, old_text }) => {
        if (!TARGETS.includes(target)) {
          return { success: false, target, entries: [], usage: { chars: 0, limit: 0, percent: 0 }, error: `Invalid target ${target}` }
        }
        let entries = await readMemoryEntries(agent, target)
        let message

        if (action === 'read') {
          return { success: true, target, entries, usage: memoryUsage(target, entries) }
        }
        if (action === 'add') {
          if (!content) return { success: false, target, entries, usage: memoryUsage(target, entries), error: 'content required' }
          const blocked = scanMemoryContent(content)
          if (blocked) return { success: false, target, entries, usage: memoryUsage(target, entries), error: `Blocked: ${blocked}` }
          if (entries.includes(content.trim())) {
            return { success: true, target, entries, usage: memoryUsage(target, entries), message: 'duplicate, no change' }
          }
          entries = [...entries, content.trim()]
          message = 'added'
        } else if (action === 'replace') {
          if (!old_text || !content) {
            return { success: false, target, entries, usage: memoryUsage(target, entries), error: 'old_text and content required' }
          }
          const blocked = scanMemoryContent(content)
          if (blocked) return { success: false, target, entries, usage: memoryUsage(target, entries), error: `Blocked: ${blocked}` }
          const matches = entries.filter((entry) => entry.includes(old_text))
          if (matches.length === 0) return { success: false, target, entries, usage: memoryUsage(target, entries), error: `No entry matched: ${old_text}` }
          if (matches.length > 1) return { success: false, target, entries, usage: memoryUsage(target, entries), error: `old_text matched ${matches.length} entries; use a more unique substring` }
          entries = entries.map((entry) => (entry === matches[0] ? content.trim() : entry))
          message = 'replaced'
        } else if (action === 'remove') {
          if (!old_text) return { success: false, target, entries, usage: memoryUsage(target, entries), error: 'old_text required' }
          const matches = entries.filter((entry) => entry.includes(old_text))
          if (matches.length === 0) return { success: false, target, entries, usage: memoryUsage(target, entries), error: `No entry matched: ${old_text}` }
          if (matches.length > 1) return { success: false, target, entries, usage: memoryUsage(target, entries), error: `old_text matched ${matches.length} entries; use a more unique substring` }
          entries = entries.filter((entry) => entry !== matches[0])
          message = 'removed'
        }

        const limit = LIMITS[target]
        const totalChars = entries.join(ENTRY_DELIMITER).length
        if (totalChars > limit) {
          const current = await readMemoryEntries(agent, target)
          return { success: false, target, entries: current, usage: memoryUsage(target, current), error: `would exceed limit (${totalChars}/${limit} chars); remove or condense entries first` }
        }
        await writeMemoryEntries(agent, target, entries)
        return { success: true, target, entries, usage: memoryUsage(target, entries), message }
      },
    }),
  ]
}
