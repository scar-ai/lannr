import { tool } from 'lannr-core'
import { z } from 'zod'
import { McpStdioClient } from './client.js'
import { readMcpRegistry } from './registry.js'
import type { McpServerConfig } from './registry.js'

const clients = new Map<string, McpStdioClient>()

function getClient(server: McpServerConfig) {
  if (!clients.has(server.id)) {
    clients.set(server.id, new McpStdioClient(server))
  }
  return clients.get(server.id)!
}

function sanitizeName(value: unknown) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
}

export async function loadMcpTools(_ctx?: unknown) {
  const servers = await readMcpRegistry()
  if (!servers.length) return []
  const tools = []
  for (const server of servers) {
    const client = getClient(server)
    let descriptors
    try {
      descriptors = await client.listTools()
    } catch (error) {
      process.stderr.write(`[mcp:${server.id}] failed to list tools: ${error instanceof Error ? error.message : String(error)}\n`)
      continue
    }
    for (const desc of descriptors) {
      const localName = `mcp_${sanitizeName(server.id)}_${sanitizeName(desc.name)}`
      tools.push(tool({
        name: localName,
        description: desc.description ? `[mcp:${server.id}] ${desc.description}` : `[mcp:${server.id}] ${desc.name}`,
        input: z.record(z.unknown()).default({}),
        output: z.unknown(),
        sideEffect: true,
        external: true,
        handler: async (input: Record<string, unknown>) => {
          const result = await client.callTool(desc.name, input ?? {})
          return result
        },
      }))
    }
  }
  return tools
}

export async function shutdownMcpClients() {
  await Promise.all([...clients.values()].map((client) => client.close()))
  clients.clear()
}
