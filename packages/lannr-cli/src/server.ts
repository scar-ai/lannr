import { createServer } from 'node:http'
import { loadConfig } from './config.js'
import { registerPlugins } from './plugins.js'
import { createRouter } from './router.js'
import { startHubScheduler } from './scheduler/manager.js'

export async function startServer(overrides: Record<string, any> = {}) {
  const config = await loadConfig(overrides)
  const plugins = await registerPlugins({ config })

  const scheduler = overrides.disableScheduler ? null : await startHubScheduler(config, {
    pollMs: overrides.schedulerPollMs,
    log: (line) => console.log(`[scheduler] ${line}`),
  })

  const router = createRouter({ config, plugins, scheduler })

  const server = createServer((req, res) => router.handle(req, res))
  server.on('upgrade', (req, socket, head) => router.upgrade(req, socket, head))

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve(undefined)
    })
  })
  const address = server.address()
  const bound = typeof address === 'object' && address ? `${address.address}:${address.port}` : `${config.host}:${config.port}`
  console.log(`Lannr hub listening on http://${bound}`)
  if (scheduler) console.log(`[scheduler] reactive routes mounted at /v1/reactive`)

  const shutdown = async () => {
    try { await scheduler?.stop() } catch {}
    server.close()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  return server
}
