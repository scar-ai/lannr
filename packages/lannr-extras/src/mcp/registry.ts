import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

export interface McpServerConfig {
  id: string
  transport: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
}

type RegistryEntry = Partial<McpServerConfig> & Record<string, unknown>

export function mcpRegistryPath() {
  return resolve(process.env.LANNR_HOME ?? resolve(homedir(), '.lannr'), 'mcp.json')
}

export async function readMcpRegistry(): Promise<McpServerConfig[]> {
  try {
    const raw = await readFile(mcpRegistryPath(), 'utf8')
    const parsed = JSON.parse(raw) as { servers?: unknown }
    const servers = Array.isArray(parsed?.servers) ? parsed.servers : []
    return servers.map(normalizeServer).filter((server): server is McpServerConfig => Boolean(server))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

export async function writeMcpRegistry(servers: McpServerConfig[]) {
  const path = mcpRegistryPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    JSON.stringify({ servers: servers.map(normalizeServer).filter((server): server is McpServerConfig => Boolean(server)) }, null, 2),
    'utf8',
  )
}

function normalizeServer(entry: unknown): McpServerConfig | null {
  if (!entry || typeof entry !== 'object') return null
  const candidate = entry as RegistryEntry
  if (!candidate.id || !candidate.command) return null
  return {
    id: String(candidate.id),
    transport: 'stdio',
    command: String(candidate.command),
    args: Array.isArray(candidate.args) ? candidate.args.map(String) : [],
    env: normalizeEnv(candidate.env),
    cwd: typeof candidate.cwd === 'string' ? candidate.cwd : undefined,
  }
}

function normalizeEnv(env: unknown): Record<string, string> {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {}
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)]))
}

export async function upsertMcpServer(entry: unknown) {
  const normalized = normalizeServer(entry)
  if (!normalized) throw new Error('Invalid MCP server entry')
  const servers = await readMcpRegistry()
  const next = servers.filter((existing) => existing.id !== normalized.id)
  next.push(normalized)
  await writeMcpRegistry(next)
  return normalized
}

export async function removeMcpServer(id: string) {
  const servers = await readMcpRegistry()
  const next = servers.filter((entry) => entry.id !== id)
  const removed = servers.length !== next.length
  if (removed) await writeMcpRegistry(next)
  return removed
}
