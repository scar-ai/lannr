import { createAgentReactiveRoutineStore } from '../scheduler/store.js'
import { HttpError, sendJson } from '../middleware/errors.js'

const MAX_BODY_BYTES = 256 * 1024

export async function handleReactiveList(req, res, context) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const requested = url.searchParams.get('agent')
  const scheduler = context.scheduler
  const agentIds = requested
    ? [resolveAgentId(context, requested)]
    : Object.values(context.config.agents).map((agent) => agent.id)
  const data = []
  for (const agentId of agentIds) {
    const agent = context.config.agents[agentId]
    if (!agent) continue
    const store = createAgentReactiveRoutineStore(agent)
    const routines = await store.list()
    data.push({
      agent: agent.id,
      schedulerRunning: Boolean(scheduler?.getLoop?.(agent.id)),
      routines: routines.map(toRoutineView),
    })
  }
  sendJson(res, 200, { object: 'list', data })
}

export async function handleReactiveRun(req, res, context, { agent, name }) {
  const loop = requireLoop(context, agent)
  const body = await readJsonBody(req)
  const payload = body && Object.prototype.hasOwnProperty.call(body, 'payload') ? body.payload : undefined
  const result = await loop.runNow(name, payload)
  sendJson(res, 200, { object: 'reactive.run', agent: loop.runtime.agent.id, id: name, result })
}

export async function handleReactiveWebhook(req, res, context, { agent, name }) {
  const loop = requireLoop(context, agent)
  const presentedSecret = extractBearerSecret(req)
  if (!presentedSecret) throw new HttpError(401, 'Missing webhook secret', { code: 'missing_secret' })
  const payload = await readJsonBody(req)
  try {
    const result = await loop.handleWebhook(name, payload, presentedSecret)
    sendJson(res, 200, { object: 'reactive.webhook', agent: loop.runtime.agent.id, id: name, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/Invalid webhook secret/i.test(message)) throw new HttpError(401, message, { code: 'invalid_secret' })
    if (/not a webhook routine/i.test(message)) throw new HttpError(409, message, { code: 'not_webhook' })
    if (/not found/i.test(message)) throw new HttpError(404, message, { code: 'routine_not_found' })
    throw error
  }
}

export async function handleReactiveEvent(req, res, context, { agent, event }) {
  const loop = requireLoop(context, agent)
  const bus = context.scheduler?.bus
  if (!bus) throw new HttpError(503, 'Scheduler bus not available', { code: 'no_bus' })
  const body = await readJsonBody(req)
  const payload = body && Object.prototype.hasOwnProperty.call(body, 'payload') ? body.payload : body
  await bus.publish(event, payload)
  sendJson(res, 202, { object: 'reactive.event', agent: loop.runtime.agent.id, event, delivered: true })
}

function requireLoop(context, agentArg) {
  if (!context.scheduler) throw new HttpError(503, 'Scheduler is not running on this gateway', { code: 'scheduler_disabled' })
  const agentId = resolveAgentId(context, agentArg)
  const loop = context.scheduler.getLoop(agentId)
  if (!loop) throw new HttpError(404, `No scheduler for agent: ${agentId}`, { code: 'agent_scheduler_not_found' })
  return loop
}

function resolveAgentId(context, requested) {
  const key = decodeURIComponent(String(requested ?? '')).trim()
  if (!key) throw new HttpError(400, 'Agent id is required', { code: 'agent_required' })
  if (context.config.agents[key]) return key
  const match = Object.values(context.config.agents).find((agent) => {
    return agent.id === key
      || agent.name?.toLowerCase() === key.toLowerCase()
      || (agent.aliases ?? []).includes(key)
  })
  if (!match) throw new HttpError(404, `Agent not found: ${key}`, { code: 'agent_not_found' })
  return match.id
}

function extractBearerSecret(req) {
  const auth = req.headers.authorization
  const header = Array.isArray(auth) ? auth[0] : auth
  if (header && /^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '').trim()
  const shared = req.headers['x-lannr-webhook-secret']
  const value = Array.isArray(shared) ? shared[0] : shared
  return typeof value === 'string' ? value.trim() : ''
}

async function readJsonBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large', { code: 'body_too_large' })
    chunks.push(chunk)
  }
  if (total === 0) return null
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON', { code: 'invalid_json' })
  }
}

function toRoutineView(routine) {
  return {
    id: routine.id,
    enabled: routine.enabled,
    trigger: routine.trigger,
    routineId: routine.routineId,
    kind: routine.agentTurn ? 'agent-turn' : 'routine',
    description: routine.description ?? null,
    nextRunAt: routine.nextRunAt?.toISOString?.() ?? null,
    lastRunAt: routine.lastRunAt?.toISOString?.() ?? null,
    lastRunStatus: routine.lastRunStatus,
    consecutiveFailures: routine.consecutiveFailures,
    failureThreshold: routine.failureThreshold,
    runningSince: routine.runningSince?.toISOString?.() ?? null,
  }
}
