import { z } from 'zod'
import { buildCacheKey, predictToolCalls } from './cache.js'
import { confidence } from './confidence.js'
import { extractProgram, stripTypeScript } from './program.js'
import { runArchaeology } from './archaeology.js'
import { schemaToType } from './schema.js'
import type {
  CacheLike,
  ConfidenceFlag,
  ExecutionStats,
  LannrEvent,
  MemoryLike,
  Message,
  McpServerLike,
  ModelAdapter,
  EmbeddingProvider,
  ModelUsage,
  RouterLike,
  RoutineLike,
  ReplayStore,
  ToolBindings,
  ToolCallRecord,
  ToolDefinition,
  OutputContract,
  VaultRunner,
} from './types.js'

export interface CreateLannrOptions {
  runner: VaultRunner
  tools: ToolDefinition[]
  model: ModelAdapter
  memory?: MemoryLike | null
  router?: RouterLike | null
  mcpServers?: McpServerLike[]
  cache?: CacheLike | null
  replayStore?: ReplayStore | null
  embedder?: EmbeddingProvider | null
  promptCacheKey?: string | null
  timeoutMs?: number
  memoryLimitMb?: number
  maxIterations?: number
}

export interface LannrRunResult {
  answer: string
  messages: Message[]
  result?: unknown
  confidence?: { score: number; flags: ConfidenceFlag[] }
  stats?: ExecutionStats
}

export function createLannr(options: CreateLannrOptions): Lannr {
  return new Lannr(options)
}

export class Lannr {
  private tools: Map<string, ToolDefinition>

  constructor(private options: CreateLannrOptions) {
    this.tools = new Map(optionsToEntries(this.options.tools))
  }

  get memory(): MemoryLike | null | undefined {
    return this.options.memory
  }

  async run(messages: Message[]): Promise<LannrRunResult> {
    let final: LannrRunResult | undefined
    for await (const event of this.stream(messages, (result) => { final = result })) {
      void event
    }
    return final ?? { answer: '', messages }
  }

  async *stream(messages: Message[], capture?: (result: LannrRunResult) => void): AsyncIterable<LannrEvent> {
    const working = [...messages]
    const routines = await this.selectRoutines(working)
    const system = this.buildSystemPrompt(routines)
    const maxIterations = this.options.maxIterations ?? 6

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      let response = ''
      // Stream user-visible prose deltas, but never leak a <program> draft (or the
      // preamble preceding one) to the consumer. We hold back any trailing text that
      // could be the start of a <program> tag until it is disambiguated, and once a
      // tag appears we stop emitting prose for the rest of this turn.
      let emitted = 0
      let programTurn = false
      for await (const chunk of this.streamModel(working, { system })) {
        if (chunk.usage) yield { type: 'lannr:model:usage', usage: chunk.usage }
        if (!chunk.text) continue
        response += chunk.text
        yield { type: 'lannr:model:delta', text: chunk.text }
        if (programTurn) continue
        if (response.includes(PROGRAM_OPEN_TAG)) { programTurn = true; continue }
        const safe = response.length - pendingTagSuffixLength(response, PROGRAM_OPEN_TAG)
        if (safe > emitted) {
          yield { type: 'lannr:answer:delta', text: response.slice(emitted, safe) }
          emitted = safe
        }
      }
      yield { type: 'lannr:thinking', text: response }
      const program = extractProgram(response)
      if (!program) {
        if (emitted < response.length) yield { type: 'lannr:answer:delta', text: response.slice(emitted) }
        yield { type: 'lannr:answer', text: response }
        const result = { answer: response, messages: working }
        capture?.(result)
        return
      }

      yield { type: 'lannr:program', code: program }
      working.push({ role: 'assistant', content: wrapProgram(program) })

      // Drain events emitted by executeProgram live, so tool:call / tool:result
      // arrive at the consumer as each tool fires — not in a batch at the end.
      const liveQueue: LannrEvent[] = []
      let wakeup: (() => void) | null = null
      const liveEmit = (event: LannrEvent) => {
        liveQueue.push(event)
        if (wakeup) { const w = wakeup; wakeup = null; w() }
      }
      let execResult: Awaited<ReturnType<typeof this.executeProgram>> | undefined
      let execError: unknown
      let execSettled = false
      this.executeProgram(stripTypeScript(program), program, routines, liveEmit)
        .then((r) => { execResult = r })
        .catch((e) => { execError = e })
        .finally(() => { execSettled = true; if (wakeup) { const w = wakeup; wakeup = null; w() } })

      while (!execSettled || liveQueue.length > 0) {
        if (liveQueue.length > 0) {
          yield liveQueue.shift()!
          continue
        }
        await new Promise<void>((r) => { wakeup = r })
      }
      if (execError) throw execError
      const exec = execResult!
      // exec.events is still populated (used for replay-cache persistence and
      // archaeology); we do NOT re-yield it here — those events already went
      // out live through liveEmit.
      const payload = JSON.stringify(await compactExecutionPayload(exec))
      working.push({ role: 'tool', content: payload })
      if (exec.savedRoutine) yield { type: 'lannr:routine:saved', name: exec.savedRoutine.name, id: exec.savedRoutine.id }
    }

    const answer = 'Lannr stopped after reaching maxIterations without a final answer.'
    yield { type: 'lannr:answer', text: answer }
    capture?.({ answer, messages: working })
  }

  private async *streamModel(messages: Message[], opts: { system?: string }): AsyncIterable<{ text?: string; usage?: ModelUsage }> {
    const modelOpts = {
      ...opts,
      ...(this.options.promptCacheKey ? { promptCacheKey: this.options.promptCacheKey } : {}),
    }
    if (this.options.model.stream) {
      for await (const chunk of this.options.model.stream(messages, modelOpts)) {
        const text = modelChunkText(chunk)
        const usage = modelChunkUsage(chunk)
        if (text || usage) yield { text, usage }
      }
      return
    }
    yield { text: modelChunkText(await this.options.model.complete(messages, modelOpts)) }
  }

  buildSystemPrompt(routines: RoutineLike[] = []): string {
    const toolStubs = [...this.tools.values()].map((tool) => `$${tool.name}(input: ${schemaToType(tool.input)}): Promise<${schemaToType(tool.output)}>`).join('\n\n')
    const routineStubs = routines.map((routine) => `$${routine.name}(input: ${schemaToType(routine.input)}): Promise<${schemaToType(routine.output)}> // ${routine.trust.level}, ${routine.trust.runs} runs`).join('\n\n')
    const router = this.options.router ? `\n$discover(query: string, limit?: number): Promise<unknown[]>\n$inspect(toolId: string): Promise<unknown>\n$invoke(toolId: string, input: unknown): Promise<unknown>` : ''
    const mcp = this.options.mcpServers?.length ? `\n$mcpListTools(server?: string): Promise<unknown[]>\n$mcpCallTool(server: string, name: string, input?: unknown): Promise<unknown>` : ''
    const memory = this.options.memory ? `\n$saveRoutine(input: { name: string; description: string; tags?: string[]; input?: unknown; output?: unknown }): Promise<{ id: string; name: string }>\n$patchRoutine(input: { routineId: string; patch: string; diff?: string; reason: string; expectedVersion?: number }): Promise<unknown>\nUse unified diffs for $patchRoutine, for example:\n--- a/routine\n+++ b/routine\n@@ -1,1 +1,1 @@\n-return oldValue\n+return newValue` : ''
    return [
      'You are an agent powered by Lannr. For simple conversation or questions that do not require tools, answer directly in prose.',
      'Only when you need to take actions, call tools, inspect external context, or compute exact results, write a <program>...</program> block containing TypeScript.',
      'Inside it, use the following typed functions (dollar-prefix):',
      toolStubs,
      routineStubs && `From memory:\n${routineStubs}`,
      router && `Router bindings:${router}`,
      mcp && `MCP bindings:${mcp}`,
      memory && `Memory bindings:${memory}`,
      'You are not able to perform file operations in pure ts, you have to use the tools you are given tools for this purpose.',
      'Rules for <program> blocks:\n- Emit raw TypeScript directly between the tags, never wrap the body in a markdown code fence\n- Always return a value from the block\n- Use Promise.all for independent calls\n- Do not import external modules\n- Math must happen in code, never in prose',
      'When the user gives you a clear task, execute it and deliver results — period. Do not first say that you will do it, ask for confirmation, or wait for the user to say yes. Do not narrate your plan. Trivial errors (syntax mistakes, wrong argument shape, missing fields) are your problem to fix silently on the next iteration. The user expects output, not a status report.',
      'After tool results: if the result contains an error field (syntax error, runtime error, type error, or any execution failure), you MUST silently write a corrected <program> block and retry. Do not mention retry attempts, malformed blocks, runner errors, or your debugging process — never apologize, explain the error, ask the user what to do, or say you will try again. Just fix and run. If the result is valid and you have enough to fully answer, write a concise prose answer. If you need another step, write another <program> block. Only produce prose when your work is genuinely complete.',
    ].filter(Boolean).join('\n\n')
  }

  async runRoutine(routine: RoutineLike, input: unknown): Promise<unknown> {
    const validated = routine.input.parse(input)
    const bindings = this.buildBindings([])
    bindings.$input = async () => validated
    try {
      const result = await this.options.runner.execute(stripTypeScript(routine.program), bindings, { timeoutMs: this.options.timeoutMs ?? 30_000, memoryLimitMb: this.options.memoryLimitMb ?? 128 })
      const parsed = routine.output.parse(result)
      await this.options.memory?.recordRun?.(routine.id, true)
      return parsed
    } catch (error) {
      await this.options.memory?.recordRun?.(routine.id, false)
      throw error
    }
  }

  private async selectRoutines(messages: Message[]): Promise<RoutineLike[]> {
    if (!this.options.memory) return []
    const summaries = await this.options.memory.list({ minTrust: 'provisional' })
    const selectedIds = this.options.model.select
      ? await this.options.model.select(messages, summaries, 5)
      : summaries.filter((summary) => messageText(messages).toLowerCase().includes(summary.name.toLowerCase()) || summary.tags.some((tag) => messageText(messages).toLowerCase().includes(tag.toLowerCase()))).slice(0, 5).map((summary) => summary.id)
    const routines = await Promise.all(selectedIds.map((id) => this.options.memory?.get(id)))
    return routines.filter((routine): routine is RoutineLike => Boolean(routine))
  }

  private async executeProgram(program: string, originalProgram: string, routines: RoutineLike[], emit: (event: LannrEvent) => void) {
    const events: LannrEvent[] = []
    const pushEvent = (event: LannrEvent) => {
      events.push(event)
      emit(event)
    }
    pushEvent({ type: 'lannr:vault:open' })
    const calls: ToolCallRecord[] = []
    const flags: ConfidenceFlag[] = []
    let savedRoutine: { id: string; name: string } | undefined
    const started = Date.now()
    let currentProgram = originalProgram

    const wrap = (name: string, fn: (input: unknown) => Promise<unknown>, output?: z.ZodTypeAny, outputContract?: OutputContract<unknown>) => async (...args: unknown[]) => {
      const input = args.length > 1 ? args : args[0]
      const callStart = Date.now()
      pushEvent({ type: 'lannr:tool:call', tool: name, input })
      try {
        const out = output ? await validateOutput(name, await fn(input), output) : await fn(input)
        const durationMs = Date.now() - callStart
        const compacted = await compactToolOutput(out, outputContract)
        calls.push({ tool: name, input, output: compacted, durationMs })
        pushEvent({ type: 'lannr:tool:result', tool: name, output: compacted, durationMs })
        return out
      } catch (error) {
        const durationMs = Date.now() - callStart
        const message = error instanceof Error ? error.message : String(error)
        flags.push('tool_error')
        calls.push({ tool: name, input, error: message, durationMs })
        pushEvent({ type: 'lannr:tool:error', tool: name, error: message })
        throw error
      }
    }

    const bindings: ToolBindings = {}
    for (const tool of this.tools.values()) bindings[`$${tool.name}`] = wrap(tool.name, async (input) => tool.handler(tool.input.parse(input)), tool.output, tool.outputContract as OutputContract<unknown> | undefined)
    for (const routine of routines) {
      bindings[`$${routine.name}`] = wrap(routine.name, async (input) => {
        const parsed = routine.input.parse(input)
        return this.runRoutine(routine, parsed)
      }, routine.output)
    }
    if (this.options.router) {
      bindings.$discover = wrap('discover', (input) => Array.isArray(input) ? this.options.router!.discover(String(input[0]), Number(input[1] ?? 10)) : this.options.router!.discover(String(input)))
      bindings.$inspect = wrap('inspect', (input) => this.options.router!.inspect(String(input)))
      bindings.$invoke = wrap('invoke', (input) => {
        if (Array.isArray(input)) return this.options.router!.invoke(String(input[0]), input[1])
        if (typeof input === 'object' && input !== null && 'toolId' in input) return this.options.router!.invoke(String((input as { toolId: unknown }).toolId), (input as { input?: unknown }).input)
        throw new Error('$invoke expects (toolId, input) or { toolId, input }')
      })
    }
    if (this.options.mcpServers?.length) {
      const servers = new Map(this.options.mcpServers.map((server) => [server.name, server]))
      bindings.$mcpListTools = wrap('mcpListTools', (input) => {
        const name = Array.isArray(input) ? input[0] : input
        if (name === undefined || name === null || name === '') return Promise.all([...servers.values()].map(async (server) => ({ server: server.name, tools: await server.listTools() })))
        const server = servers.get(String(name))
        if (!server) throw new Error(`Unknown MCP server: ${String(name)}`)
        return server.listTools()
      })
      bindings.$mcpCallTool = wrap('mcpCallTool', (input) => {
        const parsed = Array.isArray(input)
          ? { server: input[0], name: input[1], input: input[2] }
          : z.object({ server: z.string(), name: z.string(), input: z.unknown().optional() }).parse(input)
        const server = servers.get(String(parsed.server))
        if (!server) throw new Error(`Unknown MCP server: ${String(parsed.server)}`)
        return server.callTool(String(parsed.name), parsed.input)
      })
    }
    if (this.options.memory) {
      bindings.$saveRoutine = wrap('saveRoutine', async (input) => {
        const parsed = z.object({ name: z.string(), description: z.string(), tags: z.array(z.string()).default([]) }).parse(input)
        const routine: RoutineLike = { id: crypto.randomUUID(), name: parsed.name, description: parsed.description, tags: parsed.tags, input: z.unknown(), output: z.unknown(), program: currentProgram, trust: { runs: 0, successfulRuns: 0, successRate: 0, level: 'draft' } }
        await this.options.memory!.save(routine)
        savedRoutine = { id: routine.id, name: routine.name }
        return savedRoutine
      })
      bindings.$patchRoutine = wrap('patchRoutine', async (input) => {
        const parsed = z.object({ routineId: z.string(), patch: z.string().optional(), diff: z.string().optional(), reason: z.string(), expectedVersion: z.number().optional() }).parse(input)
        const patch = parsed.patch ?? parsed.diff
        if (!patch) throw new Error('$patchRoutine expects a unified diff in patch')
        return this.options.memory!.patch(parsed.routineId, { patch, diff: patch, reason: parsed.reason, expectedVersion: parsed.expectedVersion })
      })
    }

    try {
      const predictedCalls = predictToolCalls(program)
      const cacheKey = buildCacheKey(program, predictedCalls)
      const replayed = await this.options.replayStore?.getByCacheKey(cacheKey)
      if (replayed) {
        for (const ev of replayed.events) pushEvent(ev)
        return { result: replayed.result, stats: { durationMs: 0, toolCalls: replayed.resolvedBindings.map((call) => ({ ...call, cached: true })) }, confidence: replayed.confidence, events, savedRoutine }
      }
      const cached = await this.options.cache?.get(cacheKey)
      const result = cached !== undefined ? cached : await this.options.runner.execute(program, bindings, { timeoutMs: this.options.timeoutMs ?? 30_000, memoryLimitMb: this.options.memoryLimitMb ?? 128, cacheKey })
      const durationMs = Date.now() - started
      const resolvedCacheKey = buildCacheKey(program, calls)
      if (cached === undefined && calls.length > 0) {
        const ttl = resolveEffectiveTTL(calls.map((call) => call.tool), this.tools)
        if (ttl > 0) await this.options.cache?.set(resolvedCacheKey, result, ttl)
      }
      if (durationMs > (this.options.timeoutMs ?? 30_000) * 0.8) flags.push('slow_execution')
      if (result == null || (Array.isArray(result) && result.length === 0)) flags.push('empty_result')
      const conf = confidence(flags)
      const stats = { durationMs, toolCalls: calls }
      pushEvent({ type: 'lannr:vault:close', durationMs })
      pushEvent({ type: 'lannr:confidence', score: conf.score, flags: conf.flags })
      const ttl = resolveEffectiveTTL(calls.map((call) => call.tool), this.tools)
      if (ttl > 0) await this.options.replayStore?.save({ id: crypto.randomUUID(), cacheKey: resolvedCacheKey, program: originalProgram, resolvedBindings: calls, result, confidence: conf, events, error: null, durationMs, toolCallCount: calls.length, peakMemoryMb: 0, runnerType: 'node', lannrVersion: '0.1.0', createdAt: new Date(), expiresAt: new Date(Date.now() + ttl * 1000) })
      return { result, stats, confidence: conf, events, savedRoutine }
    } catch (error) {
      const durationMs = Date.now() - started
      flags.push('tool_error')
      const conf = confidence(flags)
      pushEvent({ type: 'lannr:vault:close', durationMs })
      pushEvent({ type: 'lannr:confidence', score: conf.score, flags: conf.flags })
      const execError = normalizeExecutionError(error)
      const archaeology = this.options.memory ? await runArchaeology(originalProgram, execError, this.options.memory, this.options.embedder ?? undefined) : null
      const cacheKey = buildCacheKey(program, calls)
      await this.options.replayStore?.save({ id: crypto.randomUUID(), cacheKey, program: originalProgram, resolvedBindings: calls, result: null, confidence: conf, events, error: execError, durationMs, toolCallCount: calls.length, peakMemoryMb: 0, runnerType: 'node', lannrVersion: '0.1.0', createdAt: new Date(), expiresAt: null })
      return { result: { error: execError.message, phase: execError.phase, archaeology: archaeology?.hint ?? null }, stats: { durationMs, toolCalls: calls }, confidence: conf, events, savedRoutine, archaeology }
    }
  }

  private buildBindings(routines: RoutineLike[]): ToolBindings {
    const bindings: ToolBindings = {}
    for (const tool of this.tools.values()) bindings[`$${tool.name}`] = async (input) => tool.output.parse(await tool.handler(tool.input.parse(input)))
    for (const routine of routines) bindings[`$${routine.name}`] = async (input) => this.runRoutine(routine, input)
    if (this.options.mcpServers?.length) {
      const servers = new Map(this.options.mcpServers.map((server) => [server.name, server]))
      bindings.$mcpListTools = async (serverName) => {
        if (serverName === undefined || serverName === null || serverName === '') return Promise.all([...servers.values()].map(async (server) => ({ server: server.name, tools: await server.listTools() })))
        const server = servers.get(String(serverName))
        if (!server) throw new Error(`Unknown MCP server: ${String(serverName)}`)
        return server.listTools()
      }
      bindings.$mcpCallTool = async (serverName, toolName, input) => {
        const server = servers.get(String(serverName))
        if (!server) throw new Error(`Unknown MCP server: ${String(serverName)}`)
        return server.callTool(String(toolName), input)
      }
    }
    return bindings
  }
}

function optionsToEntries(tools: ToolDefinition[]): Array<[string, ToolDefinition]> {
  return tools.map((tool) => [tool.name, tool])
}

function messageText(messages: Message[]): string {
  return messages.map((message) => message.content).join('\n')
}

async function validateOutput(name: string, value: unknown, schema: z.ZodTypeAny): Promise<unknown> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error(`Tool ${name} returned invalid output: ${parsed.error.message}`)
  return parsed.data
}

function resolveEffectiveTTL(calledTools: string[], tools: Map<string, ToolDefinition>): number {
  if (calledTools.length === 0) return 0
  const ttls = calledTools.map((name) => {
    const tool = tools.get(name)
    return tool?.sideEffect ? 0 : tool?.cacheTTL ?? 0
  })
  return ttls.some((ttl) => ttl <= 0) ? 0 : Math.min(...ttls)
}

function normalizeExecutionError(error: unknown) {
  return { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, phase: 'execute' as const }
}

const PROGRAM_OPEN_TAG = '<program>'

function wrapProgram(program: string): string {
  return `<program>\n${program}\n</program>`
}

const TOOL_OUTPUT_MAX_CHARS = 12_000
const TOOL_MESSAGE_MAX_CHARS = 24_000
const TOOL_OUTPUT_CHARS_PER_TOKEN = 4
const MAX_COMPACT_DEPTH = 5
const MAX_OBJECT_KEYS = 40
const ARRAY_HEAD = 20
const ARRAY_TAIL = 5

async function compactExecutionPayload(exec: {
  result: unknown
  confidence: { score: number; flags: ConfidenceFlag[] }
  stats: ExecutionStats
  archaeology?: unknown
}) {
  return {
    result: await compactToolOutput(exec.result),
    confidence: exec.confidence.score,
    flags: exec.confidence.flags,
    stats: {
      durationMs: exec.stats.durationMs,
      toolCalls: exec.stats.toolCalls,
    },
    archaeology: exec.archaeology ? compactToolOutputSync(exec.archaeology, TOOL_OUTPUT_MAX_CHARS) : exec.archaeology,
  }
}

async function compactToolOutput(value: unknown, contract?: OutputContract<unknown>): Promise<unknown> {
  const maxChars = contract?.maxTokens
    ? Math.max(1_000, contract.maxTokens * TOOL_OUTPUT_CHARS_PER_TOKEN)
    : TOOL_OUTPUT_MAX_CHARS
  if (contract?.compress) {
    try {
      return compactToolOutputSync(await contract.compress(value), maxChars)
    } catch (error) {
      return {
        compacted: true,
        compressionError: error instanceof Error ? error.message : String(error),
        fallback: compactToolOutputSync(value, maxChars),
      }
    }
  }
  return compactToolOutputSync(value, maxChars)
}

function compactToolOutputSync(value: unknown, maxChars = TOOL_MESSAGE_MAX_CHARS): unknown {
  const compacted = compactValue(value, 0, new WeakSet())
  const json = safeJson(compacted)
  if (json.length <= maxChars) return compacted
  return {
    compacted: true,
    original: describeValue(value),
    preview: truncateMiddle(json, maxChars),
  }
}

function compactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return truncateMiddle(value, TOOL_OUTPUT_MAX_CHARS)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  if (depth >= MAX_COMPACT_DEPTH) return describeValue(value)
  seen.add(value)

  if (Array.isArray(value)) {
    const items = value.length > ARRAY_HEAD + ARRAY_TAIL
      ? [
          ...value.slice(0, ARRAY_HEAD),
          { compacted: true, omittedItems: value.length - ARRAY_HEAD - ARRAY_TAIL },
          ...value.slice(-ARRAY_TAIL),
        ]
      : value
    return items.map((item) => compactValue(item, depth + 1, seen))
  }

  const entries = Object.entries(value)
  const out: Record<string, unknown> = {}
  for (const [key, child] of entries.slice(0, MAX_OBJECT_KEYS)) {
    out[key] = compactValue(child, depth + 1, seen)
  }
  if (entries.length > MAX_OBJECT_KEYS) out.__omittedKeys = entries.length - MAX_OBJECT_KEYS
  return out
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const suffix = `\n\n[truncated ${value.length - maxChars} chars from tool output]`
  const budget = Math.max(0, maxChars - suffix.length)
  if (budget <= 0) return suffix.slice(0, maxChars)
  const tailChars = Math.min(2_000, Math.floor(budget * 0.25))
  const headChars = budget - tailChars
  return `${value.slice(0, headChars)}\n\n[... middle content omitted ...]\n\n${value.slice(-tailChars)}${suffix}`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify(compactValue(String(value), 0, new WeakSet()))
  }
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `[Array(${value.length})]`
  if (value && typeof value === 'object') return `[Object(${Object.keys(value).length} keys)]`
  return `[${typeof value}]`
}

// Length of the longest suffix of `text` that is a proper prefix of `tag`, so a
// partially-streamed opening tag is withheld instead of leaking as prose.
function pendingTagSuffixLength(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1)
  for (let len = max; len > 0; len--) {
    if (tag.startsWith(text.slice(text.length - len))) return len
  }
  return 0
}

function modelChunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (!chunk || typeof chunk !== 'object') return ''
  const value = (chunk as { text?: unknown; delta?: unknown; content?: unknown }).text
    ?? (chunk as { text?: unknown; delta?: unknown; content?: unknown }).delta
    ?? (chunk as { text?: unknown; delta?: unknown; content?: unknown }).content
  return typeof value === 'string' ? value : ''
}

function modelChunkUsage(chunk: unknown): ModelUsage | undefined {
  if (!chunk || typeof chunk !== 'object') return undefined
  const usage = (chunk as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return undefined
  return usage as ModelUsage
}
