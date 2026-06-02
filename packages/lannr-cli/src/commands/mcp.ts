import { McpStdioClient } from '../plugins/mcp/client.js'
import {
  mcpRegistryPath,
  readMcpRegistry,
  removeMcpServer,
  upsertMcpServer,
} from '../plugins/mcp/registry.js'
import { collect, printTable } from '../cli/helpers.js'

export function register(program) {
  const mcp = program.command('mcp').description('Manage MCP (Model Context Protocol) servers')

  mcp.command('list')
    .alias('ls')
    .description('List configured MCP servers')
    .option('--json', 'print JSON')
    .action(async (opts) => {
      const servers = await readMcpRegistry()
      if (opts.json) {
        console.log(JSON.stringify({ registry: mcpRegistryPath(), servers }, null, 2))
        return
      }
      console.log(`Registry: ${mcpRegistryPath()}`)
      if (!servers.length) { console.log('No MCP servers configured.'); return }
      printTable(servers.map((server) => ({
        id: server.id,
        command: `${server.command} ${server.args.join(' ')}`.trim(),
        cwd: server.cwd ?? '',
      })))
    })

  mcp.command('add')
    .description('Register an MCP server (stdio transport)')
    .argument('<id>', 'server id')
    .requiredOption('--command <cmd>', 'command to launch the MCP server')
    .option('--arg <arg>', 'argument passed to the server; repeatable', collect, [])
    .option('--env <KEY=VALUE>', 'environment variable; repeatable', collect, [])
    .option('--cwd <dir>', 'working directory for the server')
    .action(async (id, opts) => {
      const env = {}
      for (const pair of opts.env ?? []) {
        const idx = pair.indexOf('=')
        if (idx === -1) throw new Error(`--env must be KEY=VALUE: ${pair}`)
        env[pair.slice(0, idx)] = pair.slice(idx + 1)
      }
      const saved = await upsertMcpServer({
        id,
        transport: 'stdio',
        command: opts.command,
        args: opts.arg ?? [],
        env,
        cwd: opts.cwd,
      })
      console.log(`MCP server "${saved.id}" registered.`)
    })

  mcp.command('rm')
    .alias('remove')
    .description('Remove an MCP server')
    .argument('<id>', 'server id')
    .action(async (id) => {
      const removed = await removeMcpServer(id)
      if (!removed) {
        console.error(`MCP server not found: ${id}`)
        process.exitCode = 1
        return
      }
      console.log(`MCP server "${id}" removed.`)
    })

  mcp.command('tools')
    .description('List tools exposed by a registered MCP server')
    .argument('<id>', 'server id')
    .option('--json', 'print JSON')
    .action(async (id, opts) => {
      const servers = await readMcpRegistry()
      const server = servers.find((entry) => entry.id === id)
      if (!server) {
        console.error(`MCP server not found: ${id}`)
        process.exitCode = 1
        return
      }
      const client = new McpStdioClient(server)
      try {
        const tools = await client.listTools()
        if (opts.json) {
          console.log(JSON.stringify(tools, null, 2))
          return
        }
        if (!tools.length) { console.log(`No tools exposed by ${id}.`); return }
        printTable(tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })))
      } finally {
        await client.close()
      }
    })
}
