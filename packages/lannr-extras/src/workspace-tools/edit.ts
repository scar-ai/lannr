import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { tool } from 'lannr-core'
import { z } from 'zod'
import { applyUnifiedDiff, generateUnifiedDiff } from './diff.js'
import { safeWorkspacePath, toWorkspaceRelative } from './helpers.js'

export function createEditTools(ctx) {
  const { workspace, globalReach } = ctx
  const scopeLabel = globalReach ? 'workspace or any absolute local path' : 'agent workspace'

  return [
    tool({
      name: 'editFile',
      description: [
        `Edit a file in the ${scopeLabel} by replacing an exact substring.`,
        'Provide the existing oldString and the replacement newString. oldString must appear exactly once unless replaceAll is true.',
        'Use this over writeFile when changing parts of an existing file.',
      ].join(' '),
      input: z.object({
        path: z.string(),
        oldString: z.string(),
        newString: z.string(),
        replaceAll: z.boolean().default(false),
      }),
      output: z.object({
        path: z.string(),
        replacements: z.number(),
        bytes: z.number(),
        diff: z.string(),
      }),
      sideEffect: true,
      previewForApproval: async ({ path, oldString, newString, replaceAll = false }) => {
        try {
          const filePath = safeWorkspacePath(workspace, path, globalReach)
          const current = await readFile(filePath, 'utf8')
          const proposed = replaceAll
            ? current.split(oldString).join(newString)
            : current.replace(oldString, newString)
          return {
            kind: 'diff',
            text: generateUnifiedDiff(current, proposed, toWorkspaceRelative(workspace, filePath)),
            oldPath: toWorkspaceRelative(workspace, filePath),
            newPath: toWorkspaceRelative(workspace, filePath),
          }
        } catch {
          return null
        }
      },
      handler: async ({ path, oldString, newString, replaceAll = false }) => {
        const filePath = safeWorkspacePath(workspace, path, globalReach)
        const current = await readFile(filePath, 'utf8')
        if (oldString === '') throw new Error('editFile: oldString must not be empty (use writeFile for new files)')

        const occurrences = countOccurrences(current, oldString)
        if (occurrences === 0) throw new Error(`editFile: oldString not found in ${toWorkspaceRelative(workspace, filePath)}`)
        if (!replaceAll && occurrences > 1) {
          throw new Error(`editFile: oldString matched ${occurrences} times; pass replaceAll:true or provide a more specific snippet`)
        }
        const next = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString)
        await writeFile(filePath, next, 'utf8')
        return {
          path: toWorkspaceRelative(workspace, filePath),
          replacements: replaceAll ? occurrences : 1,
          bytes: Buffer.byteLength(next),
          diff: generateUnifiedDiff(current, next, toWorkspaceRelative(workspace, filePath)),
        }
      },
    }),
    tool({
      name: 'applyPatch',
      description: [
        `Apply a unified diff (\`@@\` hunks) to a file in the ${scopeLabel}.`,
        'Use this when you already have a unified diff to apply. The diff is parsed against the current file content; mismatched context aborts the apply.',
      ].join(' '),
      input: z.object({
        path: z.string(),
        patch: z.string().min(1),
      }),
      output: z.object({
        path: z.string(),
        bytes: z.number(),
        diff: z.string(),
      }),
      sideEffect: true,
      previewForApproval: async ({ path, patch }) => {
        try {
          const filePath = safeWorkspacePath(workspace, path, globalReach)
          const current = await readFile(filePath, 'utf8').catch(() => '')
          const applied = applyUnifiedDiff(current, patch)
          if (!applied.ok) return { kind: 'text', text: `Patch will not apply: ${'error' in applied ? applied.error : 'unknown error'}\n\n${patch}` }
          return {
            kind: 'diff',
            text: generateUnifiedDiff(current, applied.program, toWorkspaceRelative(workspace, filePath)),
          }
        } catch {
          return { kind: 'text', text: patch }
        }
      },
      handler: async ({ path, patch }) => {
        const filePath = safeWorkspacePath(workspace, path, globalReach)
        let current
        try {
          current = await readFile(filePath, 'utf8')
        } catch (error) {
          if (error?.code === 'ENOENT') current = ''
          else throw error
        }
        const applied = applyUnifiedDiff(current, patch)
        if (!applied.ok) throw new Error(`applyPatch failed: ${'error' in applied ? applied.error : 'unknown error'}`)
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, applied.program, 'utf8')
        return {
          path: toWorkspaceRelative(workspace, filePath),
          bytes: Buffer.byteLength(applied.program),
          diff: generateUnifiedDiff(current, applied.program, toWorkspaceRelative(workspace, filePath)),
        }
      },
    }),
  ]
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}
