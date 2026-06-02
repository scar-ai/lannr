import { randomUUID } from 'node:crypto'
import { tool } from 'lannr-core'
import { z } from 'zod'
import { createCheckpointManager } from '../../safety/checkpoint.js'

export function createCheckpointTools(ctx) {
  const manager = createCheckpointManager(ctx.agent, { enabled: true })

  return [
    tool({
      name: 'checkpointSnapshot',
      description: [
        'Snapshot the current workspace files into a content-addressed checkpoint.',
        'Returns a turnId you can later restore with checkpointRestore.',
        'Auto-snapshots also run before each agent turn; use this tool when you want an explicit save point (e.g. before a risky edit).',
      ].join(' '),
      input: z.object({
        label: z.string().optional(),
      }).default({}),
      output: z.object({
        turnId: z.string(),
        createdAt: z.string(),
        fileCount: z.number(),
      }),
      handler: async ({ label } = {}) => {
        const turnId = label ? `${slug(label)}-${shortId()}` : shortId()
        const manifest = await manager.snapshot(turnId, null)
        if (!manifest) throw new Error('Checkpoints are disabled for this agent.')
        return {
          turnId: manifest.turnId,
          createdAt: manifest.createdAt,
          fileCount: manifest.files?.length ?? 0,
        }
      },
    }),
    tool({
      name: 'checkpointList',
      description: 'List recent checkpoints for this agent (most recent first).',
      input: z.object({
        limit: z.number().int().min(1).max(50).default(20),
      }).default({}),
      output: z.array(z.object({
        turnId: z.string(),
        createdAt: z.string(),
        agentId: z.string(),
        parentTurnId: z.string().nullable(),
        fileCount: z.number(),
      })),
      handler: async ({ limit = 20 } = {}) => {
        const entries = await manager.list()
        return entries.slice(0, limit)
      },
    }),
    tool({
      name: 'checkpointRestore',
      description: [
        'Restore the workspace to a previous checkpoint, identified by turnId.',
        'Files that existed in the checkpoint are written back; files created after the snapshot are removed.',
        'Use with care — this rewrites the workspace.',
      ].join(' '),
      input: z.object({
        turnId: z.string().min(1),
      }),
      output: z.object({
        restored: z.number(),
        removed: z.array(z.string()),
        turnId: z.string(),
        createdAt: z.string(),
      }),
      handler: async ({ turnId }) => {
        const result = await manager.restore(turnId)
        return {
          restored: result.restored,
          removed: result.removed,
          turnId: result.manifest.turnId,
          createdAt: result.manifest.createdAt,
        }
      },
    }),
  ]
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'cp'
}

function shortId() {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
}
