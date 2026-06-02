import { tool } from 'lannr-core'
import { z } from 'zod'
import { normalizeScheduleId } from '../scheduling.js'

// Routines are bound as `$<name>(input)`, so the name must be a valid JS
// identifier (underscores, not the hyphenated slug used for the on-disk id).
function toRoutineName(value) {
  const base = String(value).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  const safe = base || 'routine'
  return /^[0-9]/.test(safe) ? `r_${safe}` : safe
}

// Cheap syntax gate: wrap the body the same way the routine runner does so
// top-level `await`/`return` and `$tool` references parse without executing.
function isValidProgram(program) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(`"use strict"; return (async () => {\n${program}\n})`)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function createRoutineTools(ctx) {
  const { memory } = ctx

  return [
    tool({
      name: 'distillRoutine',
      description: [
        'Persist a reusable workflow as a DRAFT Lannr routine so it can be replayed later as `$<name>(input)`.',
        'Reach for this on your own — without being asked — the moment you finish a multi-step workflow that is general',
        'and likely to recur (e.g. "summarize recent commits", "build the weekly report", "lint then run tests").',
        'Pass a `program` that is the generalized version of what you just did: a TypeScript body that calls `$tool` bindings',
        'and ends with `return <result>`. Parameterize anything specific to this run (paths, queries) by reading from `input`.',
        'Saved routines start at trust level "draft" and graduate automatically as they run successfully.',
        'Before distilling, check the routine list in your turn context — if a close match already exists, reuse or',
        'refine it with `$patchRoutine` instead of creating a near-duplicate.',
        'Do NOT distill: one-off or trivial actions, anything secret-bearing, or work that is easier to redo than to store.',
        'Note: to capture the exact program you are running right now (no generalization), use the built-in `$saveRoutine` binding instead.',
      ].join('\n'),
      input: z.object({
        name: z.string().min(1, 'name is required'),
        description: z.string().min(1, 'description is required'),
        program: z.string().min(1, 'program is required'),
        tags: z.array(z.string()).default([]),
      }),
      output: z.object({
        success: z.boolean(),
        id: z.string().optional(),
        name: z.string().optional(),
        trust: z.string().optional(),
        message: z.string().optional(),
        error: z.string().optional(),
      }),
      sideEffect: true,
      handler: async ({ name, description, program, tags = [] }) => {
        const syntaxError = isValidProgram(program)
        if (syntaxError) {
          return { success: false, error: `program has a syntax error: ${syntaxError}` }
        }
        const id = normalizeScheduleId(name)
        const routineName = toRoutineName(name)
        const existing = await memory.get(id)
        if (existing) {
          return {
            success: false,
            id,
            name: existing.name,
            trust: existing.trust?.level,
            message: `A routine "${id}" already exists (trust: ${existing.trust?.level}). Refine it with $patchRoutine instead of re-distilling.`,
          }
        }
        await memory.save({
          id,
          name: routineName,
          description: description.trim(),
          tags: [...new Set(['distilled', ...tags])],
          input: z.unknown(),
          output: z.unknown(),
          program,
          trust: { runs: 0, successfulRuns: 0, successRate: 0, level: 'draft' },
        })
        return { success: true, id, name: routineName, trust: 'draft', message: `Saved draft routine "${id}". It becomes callable as $${routineName}(input) once it graduates to provisional after enough successful runs.` }
      },
    }),
  ]
}
