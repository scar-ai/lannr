import { homedir } from 'node:os'
import { join } from 'node:path'
import { tool } from 'lannr-core'
import { z } from 'zod'
import { runBash, safeWorkspacePath, toWorkspaceRelative, truncateBashResult } from './helpers.js'

const SKILLS_ROOT = join(homedir(), '.lannr', 'skills')

export function createBashTools(ctx) {
  const { workspace, globalReach } = ctx
  return [
    tool({
      name: 'bash',
      description: globalReach
        ? 'Run a bash command. Use cwd for a workspace-relative or absolute working directory. Prefer rg, find, sed, head, tail, and narrow commands over dumping whole files.'
        : 'Run a bash command in the agent workspace. Use cwd for a workspace-relative working directory. Prefer rg, find, sed, head, tail, and narrow commands over dumping whole files.',
      input: z.object({
        command: z.string().min(1),
        cwd: z.string().default('.'),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
      }),
      output: z.object({
        cwd: z.string(),
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number().nullable(),
        signal: z.string().nullable(),
        timedOut: z.boolean(),
        stdoutTruncated: z.boolean(),
        stderrTruncated: z.boolean(),
      }),
      sideEffect: true,
      handler: async ({ command, cwd = '.', timeoutMs = 10_000 }) => {
        const workingDirectory = safeWorkspacePath(workspace, cwd, globalReach, [SKILLS_ROOT])
        const result = await runBash(command, workingDirectory, timeoutMs)
        return {
          cwd: toWorkspaceRelative(workspace, workingDirectory),
          ...truncateBashResult(result),
        }
      },
    }),
  ]
}
