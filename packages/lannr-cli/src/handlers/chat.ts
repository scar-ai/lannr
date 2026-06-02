import { createLannrGateway } from '../gateway.js'
import { HttpError, sendJson } from '../middleware/errors.js'

export async function handleChat(req, res, context) {
  const body = await readJson(req)
  if (req.lannrAgentId && !body.agent && !body.agent_id) body.agent = req.lannrAgentId

  const gateway = await createLannrGateway(context.config)

  if (body.stream) {
    await streamResponse(req, res, gateway, body)
    return
  }

  const completion = await gateway.complete(body)
  if (req.lannrInfer) {
    sendJson(res, 200, {
      id: completion.id.replace(/^chatcmpl_/, 'lannrinf_'),
      object: 'lannr.inference',
      created: completion.created,
      agent: completion.lannr.agent,
      provider: completion.lannr.provider,
      model: completion.model,
      answer: completion.choices?.[0]?.message?.content ?? '',
      finish_reason: completion.choices?.[0]?.finish_reason ?? 'stop',
      usage: completion.usage,
      lannr: completion.lannr,
    })
    return
  }
  sendJson(res, 200, completion)
}

async function streamResponse(req, res, gateway, body) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  const writeEvent = (data) => {
    if (res.writableEnded) return false
    return res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
  }

  let clientGone = false
  const onClose = () => { clientGone = true }
  req.on('close', onClose)

  try {
    if (req.lannrInfer) {
      let runtimeInfo = null
      for await (const event of gateway.streamEvents(body)) {
        if (clientGone) break
        runtimeInfo = event.runtime ?? runtimeInfo
        if (event.type === 'lannr:answer:delta') {
          writeEvent({
            object: 'lannr.inference.chunk',
            agent: runtimeInfo?.agentId ?? null,
            provider: runtimeInfo?.providerId ?? null,
            model: runtimeInfo?.model ?? null,
            delta: event.text ?? '',
          })
        } else if (event.type === 'lannr:answer' && event.text) {
          writeEvent({
            object: 'lannr.inference.final',
            agent: runtimeInfo?.agentId ?? null,
            provider: runtimeInfo?.providerId ?? null,
            model: runtimeInfo?.model ?? null,
            answer: event.text,
            finish_reason: 'stop',
          })
        }
      }
    } else {
      for await (const chunk of gateway.stream(body)) {
        if (clientGone) break
        writeEvent(chunk)
      }
    }
    if (!clientGone) writeEvent('[DONE]')
  } catch (error) {
    if (!clientGone) {
      writeEvent({
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: 'server_error',
          code: null,
        },
      })
    }
  } finally {
    req.off('close', onClose)
    if (!res.writableEnded) res.end()
  }
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON', { code: 'invalid_json' })
  }
}
