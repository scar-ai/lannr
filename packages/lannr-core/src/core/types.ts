import type { z, ZodTypeAny } from 'zod'

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface Message {
  role: MessageRole
  content: string
}

export interface ToolCallRecord {
  tool: string
  input: unknown
  output?: unknown
  error?: string
  durationMs: number
  cached?: boolean
}

export interface ExecutionStats {
  durationMs: number
  toolCalls: ToolCallRecord[]
}

export interface ModelUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface ExecOptions {
  timeoutMs: number
  memoryLimitMb: number
  cacheKey?: string
}

export type ToolBinding = (...input: unknown[]) => Promise<unknown>
export type ToolBindings = Record<string, ToolBinding>

export interface VaultRunner {
  execute(program: string, bindings: ToolBindings, opts: ExecOptions): Promise<unknown>
}

export type LannrEvent =
  | { type: 'lannr:model:delta'; text: string }
  | { type: 'lannr:answer:delta'; text: string }
  | { type: 'lannr:model:usage'; usage: ModelUsage }
  | { type: 'lannr:thinking'; text: string }
  | { type: 'lannr:program'; code: string }
  | { type: 'lannr:vault:open' }
  | { type: 'lannr:tool:call'; tool: string; input: unknown }
  | { type: 'lannr:tool:result'; tool: string; output: unknown; durationMs: number }
  | { type: 'lannr:tool:error'; tool: string; error: string }
  | { type: 'lannr:vault:close'; durationMs: number }
  | { type: 'lannr:confidence'; score: number; flags: ConfidenceFlag[] }
  | { type: 'lannr:routine:saved'; name: string; id: string }
  | { type: 'lannr:answer'; text: string }

export type ConfidenceFlag =
  | 'tool_error'
  | 'schema_coercion'
  | 'slow_execution'
  | 'unknown_tool'
  | 'empty_result'
  | 'router_fallback'

export interface ConfidenceResult {
  score: number
  flags: ConfidenceFlag[]
}

export interface OutputContract<TOutput> {
  maxTokens: number
  compress(output: TOutput): unknown | Promise<unknown>
}

export interface ToolDefinition<TInput extends ZodTypeAny = ZodTypeAny, TOutput extends ZodTypeAny = ZodTypeAny> {
  name: string
  description?: string
  input: TInput
  output: TOutput
  tags?: string[]
  cacheTTL?: number
  sideEffect?: boolean
  outputContract?: OutputContract<z.infer<TOutput>>
  handler(input: z.infer<TInput>): Promise<z.infer<TOutput>> | z.infer<TOutput>
}

export interface ExecutionError {
  message: string
  stack?: string
  phase: 'transpile' | 'bind' | 'execute' | 'validate'
}

export interface ExecutionRecord {
  id: string
  cacheKey: string
  program: string
  resolvedBindings: ToolCallRecord[]
  result: unknown
  confidence: ConfidenceResult
  events: LannrEvent[]
  error: ExecutionError | null
  durationMs: number
  toolCallCount: number
  peakMemoryMb: number
  runnerType: 'node' | 'wasm' | 'edge'
  lannrVersion: string
  createdAt: Date
  expiresAt: Date | null
}

export interface ReplayFilter {
  since?: Date
  until?: Date
  tool?: string
  minConfidence?: number
  hasError?: boolean
  limit?: number
}

export interface ReplayStore {
  save(record: ExecutionRecord): Promise<void>
  get(id: string): Promise<ExecutionRecord | null>
  getByCacheKey(key: string): Promise<ExecutionRecord | null>
  list(filter?: ReplayFilter): Promise<ExecutionRecord[]>
  delete(id: string): Promise<void>
  purgeExpired(): Promise<number>
}

export interface ModelRequestOptions {
  system?: string
  promptCacheKey?: string
}

export interface ModelAdapter {
  complete(messages: Message[], opts?: ModelRequestOptions): Promise<string>
  stream?(messages: Message[], opts?: ModelRequestOptions): AsyncIterable<string | { text?: string; delta?: string; content?: string; usage?: ModelUsage }>
  select?(
    messages: Message[],
    candidates: Array<{ id: string; name: string; description: string; tags: string[] }>,
    maxCount: number,
  ): Promise<string[]>
}

export interface RoutineLike {
  id: string
  name: string
  description: string
  tags: string[]
  input: ZodTypeAny
  output: ZodTypeAny
  program: string
  version?: number
  changelog?: ProgramDiffLike[]
  embedding?: number[]
  trust: { level: 'draft' | 'provisional' | 'trusted' | 'pinned'; runs: number; successfulRuns: number; successRate: number }
}

export interface ProgramDiffLike {
  version: number
  patch: string
  diff?: string
  reason: string
  appliedAt: Date
  outcome: 'success' | 'failure' | 'rolled-back'
  resultedIn?: 'success' | 'failure'
  failureError?: string
  type?: 'diff' | 'full-rewrite'
}

export interface MemoryLike {
  list(filter?: { tags?: string[]; minTrust?: 'draft' | 'provisional' | 'trusted' | 'pinned' }): Promise<Array<Pick<RoutineLike, 'id' | 'name' | 'description' | 'tags' | 'trust'>>>
  get(id: string): Promise<RoutineLike | null>
  save(routine: RoutineLike): Promise<void>
  patch(id: string, diff: { diff?: string; patch?: string; reason: string; expectedVersion?: number; outcome?: 'success' | 'failure' | 'rolled-back'; failureError?: string }): Promise<RoutineLike>
  recordRun?(id: string, success: boolean): Promise<RoutineLike>
}

export interface RouterLike {
  discover(query: string, limit?: number): Promise<unknown[]>
  inspect(toolId: string): Promise<unknown>
  invoke(toolId: string, input: unknown): Promise<unknown>
}

export interface McpServerLike {
  name: string
  listTools(): Promise<unknown[]>
  callTool(name: string, input?: unknown): Promise<unknown>
}

export interface CacheLike {
  get(key: string): Promise<unknown | undefined> | unknown | undefined
  set(key: string, value: unknown, ttlSeconds: number): Promise<void> | void
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
  embedBatch?(texts: string[]): Promise<number[][]>
}
