import { randomUUID } from 'node:crypto'

function completionId(prefix) {
  return `${prefix}-${randomUUID()}`
}

function unixTime() {
  return Math.floor(Date.now() / 1000)
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages.map((message) => ({
    role: ['system', 'user', 'assistant', 'tool'].includes(message?.role) ? message.role : 'user',
    content: typeof message?.content === 'string' || Array.isArray(message?.content)
      ? message.content
      : String(message?.content ?? ''),
  }))
}

function promptToMessages(prompt) {
  if (Array.isArray(prompt)) return normalizeMessages(prompt)
  const content = String(prompt ?? '').trim()
  return content ? [{ role: 'user', content }] : []
}

function chatChunk({ model, delta, finishReason }) {
  return {
    id: completionId('chatcmpl'),
    object: 'chat.completion.chunk',
    created: unixTime(),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

interface LannrGatewayOptions {
  createRuntime?: (request: any) => Promise<any> | any
  appendSessionTurn?: (runtime: any, request: any, turn: any) => Promise<void> | void
}

export async function createLannrGateway({ createRuntime, appendSessionTurn }: LannrGatewayOptions = {}) {
  if (typeof createRuntime !== 'function') throw new Error('createLannrGateway requires createRuntime(request)')

  async function* streamEvents(request: any = {}, onFinal?: (result: any) => void) {
    const runtime = await createRuntime(request)
    const runtimeInfo = {
      agentId: runtime.agent?.id ?? runtime.agentId ?? null,
      providerId: runtime.provider?.id ?? runtime.providerId ?? null,
      model: runtime.provider?.defaultModel ?? runtime.provider?.model ?? runtime.model ?? 'lannr',
    }
    const messages = normalizeMessages(request.messages ?? promptToMessages(request.prompt ?? request.message))
    let final = null
    const events = []
    let answer = ''
    for await (const event of runtime.lannr.stream(messages, (result) => { final = result })) {
      events.push(event)
      if (event.type === 'lannr:model:delta') {
        yield { type: 'lannr:answer:delta', text: event.text ?? '', runtime: runtimeInfo }
      }
      if (event.type === 'lannr:answer') answer = event.text ?? answer
      yield { ...event, runtime: runtimeInfo }
    }
    if (final && answer && final.answer !== answer) final = { ...final, answer }
    onFinal?.(final)
    if (request.session && appendSessionTurn) {
      await appendSessionTurn(runtime, request, { messages, events, final, runtime: runtimeInfo })
    }
  }

  return {
    async complete(request = {}) {
      let answer = ''
      let final = null
      let runtimeInfo = null
      for await (const event of streamEvents(request, (result) => { final = result })) {
        runtimeInfo = event.runtime ?? runtimeInfo
        if (event.type === 'lannr:answer') answer = event.text ?? answer
      }
      return {
        id: completionId('chatcmpl'),
        object: 'chat.completion',
        created: unixTime(),
        model: runtimeInfo?.model ?? 'lannr',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: null,
        lannr: {
          agent: runtimeInfo?.agentId ?? null,
          provider: runtimeInfo?.providerId ?? null,
          confidence: final?.confidence ?? null,
          stats: final?.stats ?? null,
        },
      }
    },
    async *stream(request = {}) {
      let runtimeInfo = null
      yield chatChunk({ model: 'lannr', delta: { role: 'assistant' }, finishReason: null })
      for await (const event of streamEvents(request)) {
        runtimeInfo = event.runtime ?? runtimeInfo
        if (event.type === 'lannr:answer:delta' && event.text) {
          yield chatChunk({ model: runtimeInfo?.model ?? 'lannr', delta: { content: event.text }, finishReason: null })
        }
      }
      yield chatChunk({ model: runtimeInfo?.model ?? 'lannr', delta: {}, finishReason: 'stop' })
    },
    streamEvents,
  }
}
