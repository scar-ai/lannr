import { handleChat } from './handlers/chat.js'
import {
  handleReactiveEvent,
  handleReactiveList,
  handleReactiveRun,
  handleReactiveWebhook,
} from './handlers/reactive.js'
import { handleStreamUpgrade } from './handlers/stream.js'
import { handleError, notFound, sendJson } from './middleware/errors.js'

export function createRouter(context) {
  return {
    async handle(req, res) {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

        if (req.method === 'GET' && url.pathname === '/health') {
          sendJson(res, 200, { status: 'ok' })
          return
        }

        if (req.method === 'GET' && url.pathname === '/v1/agents') {
          const agents = Object.values(context.config.agents).map((agent) => ({
            id: agent.id,
            name: agent.name,
            description: agent.description,
            provider: agent.provider,
            model: agent.providerConfig?.model ?? agent.model ?? null,
            workspace: agent.workspace,
            default: agent.id === context.config.defaultAgentId,
            aliases: agent.aliases ?? [],
          }))
          sendJson(res, 200, { object: 'list', data: agents })
          return
        }

        if (req.method === 'POST' && (url.pathname === '/chat' || url.pathname === '/v1/chat/completions')) {
          await handleChat(req, res, context)
          return
        }

        const agentInfer = url.pathname.match(/^\/v1\/agents\/([^/]+)\/infer$/)
        if (req.method === 'POST' && (url.pathname === '/v1/infer' || agentInfer)) {
          req.lannrAgentId = agentInfer ? decodeURIComponent(agentInfer[1]) : undefined
          req.lannrInfer = true
          await handleChat(req, res, context)
          return
        }

        if (req.method === 'GET' && url.pathname === '/v1/reactive') {
          await handleReactiveList(req, res, context)
          return
        }

        const reactiveRun = url.pathname.match(/^\/v1\/reactive\/run\/([^/]+)\/([^/]+)$/)
        if (req.method === 'POST' && reactiveRun) {
          await handleReactiveRun(req, res, context, {
            agent: decodeURIComponent(reactiveRun[1]),
            name: decodeURIComponent(reactiveRun[2]),
          })
          return
        }

        const reactiveWebhook = url.pathname.match(/^\/v1\/reactive\/webhook\/([^/]+)\/([^/]+)$/)
        if (req.method === 'POST' && reactiveWebhook) {
          await handleReactiveWebhook(req, res, context, {
            agent: decodeURIComponent(reactiveWebhook[1]),
            name: decodeURIComponent(reactiveWebhook[2]),
          })
          return
        }

        const reactiveEvent = url.pathname.match(/^\/v1\/reactive\/events\/([^/]+)\/([^/]+)$/)
        if (req.method === 'POST' && reactiveEvent) {
          await handleReactiveEvent(req, res, context, {
            agent: decodeURIComponent(reactiveEvent[1]),
            event: decodeURIComponent(reactiveEvent[2]),
          })
          return
        }

        notFound(res)
      } catch (error) {
        handleError(error, res)
      }
    },

    upgrade(req, socket, head) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      if (url.pathname === '/stream' || url.pathname === '/v1/chat/completions/stream') {
        handleStreamUpgrade(req, socket, head, context)
        return
      }
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
    },
  }
}
