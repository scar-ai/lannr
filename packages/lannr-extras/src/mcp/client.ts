import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { McpServerConfig } from './registry.js'

const PROTOCOL_VERSION = '2024-11-05'

interface PendingRequest {
  resolve(value: unknown): void
  reject(reason?: unknown): void
}

interface JsonRpcResponse {
  id?: number | string | null
  result?: unknown
  error?: {
    code?: number | string
    message?: string
  }
}

interface ToolDescriptor {
  name: string
  description?: string
}

export class McpStdioClient {
  id: string
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
  child: ChildProcessWithoutNullStreams | null
  connecting: Promise<void> | null
  nextId: number
  pending: Map<number, PendingRequest>
  buffer: string
  initialized: boolean

  constructor({ id, command, args = [], env = {}, cwd }: McpServerConfig) {
    if (!command) throw new Error(`MCP server "${id}" missing command`)
    this.id = id ?? command
    this.command = command
    this.args = args
    this.env = { ...process.env, ...env }
    this.cwd = cwd
    this.child = null
    this.connecting = null
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.initialized = false
  }

  async ensureConnected() {
    if (this.initialized) return
    if (!this.connecting) {
      this.connecting = (async () => {
        await this._spawn()
        await this._initialize()
        this.initialized = true
      })().catch((error) => {
        this.connecting = null
        throw error
      })
    }
    await this.connecting
  }

  async _spawn() {
    this.child = spawn(this.command, this.args, {
      env: this.env,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk))
    this.child.stderr.on('data', (chunk) => {
      process.stderr.write(`[mcp:${this.id}] ${chunk}`)
    })
    this.child.on('exit', (code) => {
      const err = new Error(`MCP server "${this.id}" exited with code ${code}`)
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
      this.initialized = false
      this.connecting = null
      this.child = null
    })
  }

  _onStdout(chunk: string) {
    this.buffer += chunk
    let newlineIdx
    while ((newlineIdx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim()
      this.buffer = this.buffer.slice(newlineIdx + 1)
      if (!line) continue
      try {
        const message = JSON.parse(line)
        this._dispatch(message)
      } catch (error) {
        process.stderr.write(`[mcp:${this.id}] invalid JSON line: ${line}\n`)
      }
    }
  }

  _dispatch(message: JsonRpcResponse) {
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`))
      else entry.resolve(message.result)
    }
  }

  async _initialize() {
    await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'lannr-cli', version: '0.1.0' },
    })
    this._notify('notifications/initialized', {})
  }

  _request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const message = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      if (!this.child) {
        reject(new Error(`MCP server "${this.id}" is not connected`))
        return
      }
      this.child.stdin.write(`${JSON.stringify(message)}\n`)
    })
  }

  _notify(method: string, params: unknown) {
    const message = { jsonrpc: '2.0', method, params }
    if (!this.child) throw new Error(`MCP server "${this.id}" is not connected`)
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  async listTools(): Promise<ToolDescriptor[]> {
    await this.ensureConnected()
    const result = await this._request('tools/list', {})
    if (!result || typeof result !== 'object' || !('tools' in result) || !Array.isArray(result.tools)) return []
    return result.tools.filter((tool): tool is ToolDescriptor => (
      !!tool && typeof tool === 'object' && 'name' in tool && typeof tool.name === 'string'
    ))
  }

  async callTool(name: string, args: Record<string, unknown>) {
    await this.ensureConnected()
    return this._request('tools/call', { name, arguments: args ?? {} })
  }

  async close() {
    if (this.child) {
      try { this.child.kill('SIGTERM') } catch { /* ignore */ }
      this.child = null
    }
    this.initialized = false
    this.connecting = null
  }
}
