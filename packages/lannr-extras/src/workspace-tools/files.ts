import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tool } from 'lannr-core'
import { z } from 'zod'
import { generateUnifiedDiff } from './diff.js'
import {
  DEFAULT_TEXT_RESULT_CHARS,
  displayPath,
  safeWorkspacePath,
  toWorkspaceRelative,
  truncateText,
} from './helpers.js'

export function createFileTools(ctx) {
  const { workspace, agent, globalReach } = ctx
  const readOnlyRoots = ctx.readOnlyRoots ?? []
  const agentMemoryDir = ctx.agentMemoryDir ?? ((entry) => `${entry.agentDir}/memory`)
  const scopeLabel = globalReach ? 'workspace or any absolute local path' : 'agent workspace'

  return [
    tool({
      name: 'readFile',
      description: `Read a UTF-8 text file from the ${scopeLabel}. Prefer targeted paths and smaller maxChars; use bash with rg/sed for search, line ranges, directory listings, binary files, or PDFs.`,
      input: z.object({
        path: z.string(),
        maxChars: z.number().int().min(1_000).max(200_000).default(DEFAULT_TEXT_RESULT_CHARS),
      }),
      output: z.object({ path: z.string(), content: z.string(), truncated: z.boolean(), bytes: z.number() }),
      handler: async ({ path, maxChars = DEFAULT_TEXT_RESULT_CHARS }) => {
        const filePath = safeWorkspacePath(workspace, path, globalReach, readOnlyRoots)
        const content = await readFile(filePath, 'utf8')
        return {
          path: displayPath(workspace, filePath),
          content: truncateText(content, maxChars),
          truncated: content.length > maxChars,
          bytes: Buffer.byteLength(content),
        }
      },
    }),
    tool({
      name: 'writeFile',
      description: `Write a UTF-8 text file in the ${scopeLabel}. For modifications to existing files prefer editFile or applyPatch.`,
      input: z.object({ path: z.string(), content: z.string() }),
      output: z.object({ path: z.string(), bytes: z.number() }),
      sideEffect: true,
      previewForApproval: async ({ path, content }) => {
        try {
          const filePath = safeWorkspacePath(workspace, path, globalReach)
          const current = await readFile(filePath, 'utf8').catch((error) => {
            if (error?.code === 'ENOENT') return null
            throw error
          })
          if (current == null) {
            return { kind: 'text', text: `new file (${Buffer.byteLength(content)} bytes)\n\n${content.slice(0, 600)}` }
          }
          return {
            kind: 'diff',
            text: generateUnifiedDiff(current, content, toWorkspaceRelative(workspace, filePath)),
          }
        } catch {
          return null
        }
      },
      handler: async ({ path, content }) => {
        const filePath = safeWorkspacePath(workspace, path, globalReach)
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, content, 'utf8')
        return { path: toWorkspaceRelative(workspace, filePath), bytes: Buffer.byteLength(content) }
      },
    }),
    tool({
      name: 'appendMemory',
      description: [
        'Append a durable memory note for this agent.',
        'Use this only for stable preferences, decisions, facts, or context the user explicitly wants remembered.',
      ].join(' '),
      input: z.object({
        note: z.string().min(1),
        scope: z.enum(['daily', 'longTerm']).default('daily'),
      }),
      output: z.object({ path: z.string(), bytes: z.number() }),
      sideEffect: true,
      handler: async ({ note, scope = 'daily' }) => {
        const memoryDir = agentMemoryDir(agent)
        await mkdir(memoryDir, { recursive: true })
        const fileName = scope === 'longTerm' ? 'MEMORY.md' : `${new Date().toISOString().slice(0, 10)}.md`
        const filePath = join(memoryDir, fileName)
        const entry = `\n- ${new Date().toISOString()}: ${note.trim()}\n`
        await appendFile(filePath, entry, 'utf8')
        return { path: toWorkspaceRelative(workspace, filePath), bytes: Buffer.byteLength(entry) }
      },
    }),
  ]
}
