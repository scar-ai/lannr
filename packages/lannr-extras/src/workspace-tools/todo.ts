import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tool } from 'lannr-core'
import { z } from 'zod'

const STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const

function tasksDir(agent) {
  return resolve(agent.agentDir, 'tasks')
}

function sessionKey(ctx) {
  return ctx?.session ?? ctx?.sessionId ?? 'default'
}

async function readList(path) {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(validate)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function writeList(path, items) {
  await mkdir(resolve(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(items, null, 2))
  await rename(tmp, path)
}

function validate(item) {
  return {
    id: String(item?.id ?? '').trim() || cryptoRandomId(),
    content: String(item?.content ?? '').trim() || '(no description)',
    status: STATUSES.includes(item?.status) ? item.status : 'pending',
  }
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10)
}

function summarize(items) {
  return {
    total: items.length,
    pending: items.filter((item) => item.status === 'pending').length,
    in_progress: items.filter((item) => item.status === 'in_progress').length,
    completed: items.filter((item) => item.status === 'completed').length,
    cancelled: items.filter((item) => item.status === 'cancelled').length,
  }
}

export async function loadTodos(agent, session) {
  return readList(join(tasksDir(agent), `${session}.json`))
}

export function createTodoTools(ctx) {
  const path = () => join(tasksDir(ctx.agent), `${sessionKey(ctx)}.json`)

  return [
    tool({
      name: 'todo',
      description: [
        'Manage the task list for the current session. Use for multi-step work (3+ steps) or when the user provides multiple tasks.',
        'Call with no params to read. Provide `todos` to write.',
        'merge=false (default): replaces the entire list with a fresh plan.',
        'merge=true: updates items by id and appends new ones.',
        'Each item: { id, content, status: pending|in_progress|completed|cancelled }.',
        'Only ONE item should be in_progress at a time. Mark items completed immediately when done.',
      ].join(' '),
      input: z.object({
        todos: z.array(z.object({
          id: z.string(),
          content: z.string(),
          status: z.enum(STATUSES),
        })).optional(),
        merge: z.boolean().default(false),
        clear: z.boolean().default(false),
      }).default({}),
      output: z.object({
        todos: z.array(z.object({
          id: z.string(),
          content: z.string(),
          status: z.string(),
        })),
        summary: z.object({
          total: z.number(),
          pending: z.number(),
          in_progress: z.number(),
          completed: z.number(),
          cancelled: z.number(),
        }),
      }),
      handler: async ({ todos, merge = false, clear = false } = {}) => {
        const file = path()
        if (clear) {
          await writeList(file, [])
          return { todos: [], summary: summarize([]) }
        }
        if (!todos) {
          const items = await readList(file)
          return { todos: items, summary: summarize(items) }
        }
        const validated = todos.map(validate)
        let next
        if (merge) {
          const existing = await readList(file)
          const byId = new Map(existing.map((item) => [item.id, item]))
          for (const item of validated) byId.set(item.id, { ...byId.get(item.id), ...item })
          // preserve original order, append new ids at end
          const order = existing.map((item) => item.id)
          for (const item of validated) if (!order.includes(item.id)) order.push(item.id)
          next = order.map((id) => byId.get(id)).filter(Boolean)
        } else {
          // dedupe by id, last wins
          const map = new Map()
          for (const item of validated) map.set(item.id, item)
          next = [...map.values()]
        }
        await writeList(file, next)
        return { todos: next, summary: summarize(next) }
      },
    }),
  ]
}
