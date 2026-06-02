# Lannr SDK

Lannr is a code-native agentic runtime for TypeScript. Instead of asking a model to emit one JSON tool call at a time, Lannr asks the model to write a short TypeScript program, runs that program in a Vault, and returns the execution result to the conversation.

The model can compose tools with normal language features: `Promise.all`, loops, conditionals, `map`, `reduce`, and explicit arithmetic. Lannr handles tool binding, schema validation, execution tracing, replay, routine memory, dynamic routing, and reactive scheduling.

## Packages

The SDK ships as two packages. `lannr-core` holds the core mechanics; `lannr-extras` holds the optional capabilities and depends on `lannr-core`. Each capability is reachable through a stable subpath export.

### `lannr-core`

| Import | Purpose |
| --- | --- |
| `lannr-core` | Runtime primitives, `tool()`, `createLannr()`, replay, diffing, confidence, archaeology |
| `lannr-core/providers` | Provider registry plus OpenAI-compatible, Anthropic, Google, and Codex adapters |
| `lannr-core/runner` | Shared runner types (`VaultRunner`, `ExecOptions`, `ToolBindings`) |
| `lannr-core/runner-node` | Node Vault runner using a constrained `node:vm` context |
| `lannr-core/runner-wasm` | WASM-oriented runner (`quickjs-emscripten` backend) |
| `lannr-core/runner-edge` | HTTP bridge runner for edge execution |
| `lannr-core/agents` | Agent registry, isolated agent layout, agent memory path helpers, and persisted chat sessions |
| `lannr-core/gateway` | Conversation gateway helpers, OpenAI-style completion/stream wrappers, and context compaction |

### `lannr-extras`

| Import | Purpose |
| --- | --- |
| `lannr-extras/memory` | Routine persistence, trust tracking, patching, rollback, agent-rooted memory store |
| `lannr-extras/scheduler` | Reactive routines: cron, event, and webhook triggers |
| `lannr-extras/workspace-tools` | Node workspace tools for files, edits, bash, todos, and checkpoints |
| `lannr-extras/browser` | Chrome/CDP browser automation tools |
| `lannr-extras/mcp` | MCP stdio client, local registry, and tool bridge |
| `lannr-extras/devtools` | Execution timeline and memory browser helpers |

The `lannr` CLI is published from `packages/lannr-cli` and is built on top of both packages.

Dynamic tool discovery (`$discover` / `$inspect` / `$invoke`) is still supported by `createLannr()` through any object that implements the `RouterLike` interface; the SDK no longer ships a bundled router implementation.

## Installation

Minimal local setup:

```sh
pnpm add lannr-core zod
```

`lannr-extras` pulls in `lannr-core` automatically:

```sh
pnpm add lannr-core lannr-extras zod
```

This repository is a pnpm workspace. From the repo root:

```sh
pnpm install
pnpm build
pnpm test
```

## Quick Start

```ts
import { createLannr, tool } from 'lannr-core'
import { createModelAdapter } from 'lannr-core/providers'
import { nodeRunner } from 'lannr-core/runner-node'
import { z } from 'zod'

const getTopProducts = tool({
  name: 'getTopProducts',
  description: 'Get top-selling products',
  input: z.object({ limit: z.number().int().positive() }),
  output: z.object({
    products: z.array(z.object({ id: z.number(), name: z.string() })),
  }),
  cacheTTL: 300,
  handler: async ({ limit }) => ({
    products: [
      { id: 1, name: 'Notebook' },
      { id: 2, name: 'Pen' },
    ].slice(0, limit),
  }),
})

const getProductRatings = tool({
  name: 'getProductRatings',
  input: z.object({ productId: z.string() }),
  output: z.object({ ratings: z.array(z.object({ score: z.number() })) }),
  cacheTTL: 300,
  handler: async ({ productId }) => ({
    ratings: productId === '1'
      ? [{ score: 4 }, { score: 5 }]
      : [{ score: 3 }, { score: 4 }],
  }),
})

const lannr = createLannr({
  runner: nodeRunner({ timeoutMs: 30_000, memoryLimitMb: 128 }),
  model: createModelAdapter({
    id: 'openai',
    type: 'openai-compatible',
    model: 'gpt-4.1',
    baseURL: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    endpoint: 'chat-completions',
  }),
  tools: [getTopProducts, getProductRatings],
})

const result = await lannr.run([
  { role: 'user', content: 'Get the top 2 products and average ratings.' },
])

console.log(result.answer)
```

Lannr will prompt the model to write a program wrapped in `<program>…</program>` XML tags, such as:

```
<program>
const top = await $getTopProducts({ limit: 2 })
const ratings = await Promise.all(
  top.products.map((product) =>
    $getProductRatings({ productId: String(product.id) })
  )
)

return top.products.map((product, index) => {
  const scores = ratings[index].ratings.map((rating) => rating.score)
  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length
  return { name: product.name, averageRating: Math.round(average * 100) / 100 }
})
</program>
```

## Core Concepts

### Programs, Not Tool Calls

Traditional agents ask the model to choose a tool, execute it, append the result, and call the model again. Lannr asks the model for a program. The program can call many tools in one execution and compute exact results in JavaScript.

### Vault

A Vault is the isolated execution environment used by a runner. Each `lannr.run()` or `lannr.runRoutine()` execution receives bindings such as `$getWeather` and executes the model-written program with timeout options.

The public runner contract is:

```ts
interface VaultRunner {
  execute(
    program: string,
    bindings: Record<string, (...args: unknown[]) => Promise<unknown>>,
    opts: { timeoutMs: number; memoryLimitMb: number; cacheKey?: string }
  ): Promise<unknown>
}
```

### Dollar-Prefixed Bindings

Every tool named `getWeather` is exposed inside the Vault as `$getWeather`.

Router and memory bindings are also dollar-prefixed:

```ts
await $discover('calendar tools')
await $inspect('remote.tool.id')
await $invoke('remote.tool.id', { value: 123 })

await $saveRoutine({ name: 'weeklyReport', description: '...' })
await $patchRoutine({ routineId, patch, reason })
```

MCP server bindings are available when `mcpServers` are configured:

```ts
await $mcpListTools('filesystem')
await $mcpCallTool('filesystem', 'read_file', { path: '/tmp/example.txt' })
```

## Defining Tools

Use `tool()` from `lannr-core`.

```ts
import { tool } from 'lannr-core'
import { z } from 'zod'

export const getWeather = tool({
  name: 'getWeather',
  description: 'Fetch current weather for a city',
  input: z.object({
    city: z.string(),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  output: z.object({
    temperature: z.number(),
    condition: z.string(),
    humidity: z.number(),
  }),
  tags: ['weather', 'location'],
  cacheTTL: 300,
  handler: async ({ city, units }) => {
    return {
      temperature: 21,
      condition: 'sunny',
      humidity: 0.42,
    }
  },
})
```

Fields:

| Field | Required | Description |
| --- | --- | --- |
| `name` | Yes | Binding name. `getWeather` becomes `$getWeather`. |
| `description` | No | Used in generated system prompts. |
| `input` | Yes | Zod schema for tool input. |
| `output` | Yes | Zod schema for tool output. |
| `tags` | No | Metadata for memory/router retrieval. |
| `cacheTTL` | No | Seconds to cache replayable executions. Default is `0`. |
| `sideEffect` | No | If `true`, execution is not cached. |
| `outputContract` | No | `{ maxTokens, compress }` — limits and compresses tool output before it is returned to the model. |
| `handler` | Yes | Function called outside the Vault. |

Input is parsed before the handler runs. Output is parsed after the handler returns. Invalid inputs or outputs are execution failures and lower confidence.

## Creating a Lannr Runtime

```ts
import { createLannr, MemoryCache, MemoryReplayStore } from 'lannr-core'
import { nodeRunner } from 'lannr-core/runner-node'

const lannr = createLannr({
  runner: nodeRunner(),
  model: {
    async complete() {
      return '<program>\nreturn await $double({ value: 21 })\n</program>'
    },
  },
  tools: [double],
  cache: new MemoryCache(),
  replayStore: new MemoryReplayStore(),
  timeoutMs: 30_000,
  memoryLimitMb: 128,
  maxIterations: 6,
})
```

Options:

| Option | Required | Description |
| --- | --- | --- |
| `runner` | Yes | Vault runner. |
| `tools` | Yes | Tool definitions exposed as `$toolName`. |
| `model` | Yes | Model adapter. |
| `memory` | No | Routine store. Enables routine selection and memory bindings. |
| `router` | No | Dynamic tool router. Enables `$discover`, `$inspect`, `$invoke`. |
| `mcpServers` | No | Connected MCP server adapters. Enables `$mcpListTools`, `$mcpCallTool`. |
| `cache` | No | Execution result cache. |
| `replayStore` | No | Execution record store. |
| `embedder` | No | Embedding provider for Failure Archaeology. |
| `promptCacheKey` | No | Stable key passed to model adapters for prompt caching. |
| `timeoutMs` | No | Per-execution timeout. Default `30_000`. |
| `memoryLimitMb` | No | Runner memory limit hint. Default `128`. |
| `maxIterations` | No | Max model/execution loops. Default `6`. |

### Connecting MCP Servers

Pass connected MCP server adapters when creating the runtime. Lannr stays transport-agnostic: use any MCP client to connect to stdio, HTTP, or another transport, then expose this adapter shape:

```ts
interface McpServerLike {
  name: string
  listTools(): Promise<unknown[]>
  callTool(name: string, input?: unknown): Promise<unknown>
}
```

```ts
const lannr = createLannr({
  runner: nodeRunner(),
  model,
  tools: [],
  mcpServers: [{
    name: 'filesystem',
    listTools: () => filesystemClient.listTools(),
    callTool: (name, input) => filesystemClient.callTool({ name, arguments: input }),
  }],
})
```

The agent can list tools from one server, list tools from every configured server, or call a server tool:

```ts
const filesystemTools = await $mcpListTools('filesystem')
const allTools = await $mcpListTools()
return await $mcpCallTool('filesystem', 'read_file', { path: '/tmp/example.txt' })
```

`$mcpListTools()` returns grouped results when no server name is provided:

```ts
[
  { server: 'filesystem', tools: [...] },
  { server: 'github', tools: [...] },
]
```

## Running and Streaming

`run()` returns the final answer, message history, and execution metadata:

```ts
const result = await lannr.run([
  { role: 'user', content: 'Double 21.' },
])

console.log(result.answer)      // final prose answer
console.log(result.messages)    // full conversation history
console.log(result.result)      // raw program return value (if a program ran)
console.log(result.confidence)  // { score, flags } from the last execution
console.log(result.stats)       // { durationMs, toolCalls }
```

`stream()` yields runtime events:

```ts
for await (const event of lannr.stream([{ role: 'user', content: 'Double 21.' }])) {
  if (event.type === 'lannr:answer:delta') process.stdout.write(event.text)
  if (event.type === 'lannr:program') console.log(event.code)
  if (event.type === 'lannr:tool:call') console.log(event.tool, event.input)
  if (event.type === 'lannr:answer') console.log(event.text)
}
```

Event types:

```ts
type LannrEvent =
  | { type: 'lannr:model:delta'; text: string }       // raw model token (every chunk)
  | { type: 'lannr:answer:delta'; text: string }      // prose-only delta (suppressed during program turns)
  | { type: 'lannr:model:usage'; usage: ModelUsage }  // token usage from provider
  | { type: 'lannr:thinking'; text: string }
  | { type: 'lannr:program'; code: string }
  | { type: 'lannr:vault:open' }
  | { type: 'lannr:tool:call'; tool: string; input: unknown }
  | { type: 'lannr:tool:result'; tool: string; output: unknown; durationMs: number }
  | { type: 'lannr:tool:error'; tool: string; error: string }
  | { type: 'lannr:vault:close'; durationMs: number }
  | { type: 'lannr:confidence'; score: number; flags: string[] }
  | { type: 'lannr:routine:saved'; name: string; id: string }
  | { type: 'lannr:answer'; text: string }
```

## Model Adapters

Use `lannr-core/providers` to create model adapters for OpenAI-compatible, Anthropic, Google, and Codex-backed providers.

```ts
import { createModelAdapter, listProviders, getPrimaryProvider } from 'lannr-core/providers'

const provider = await getPrimaryProvider() ?? (await listProviders())[0]
const model = createModelAdapter({
  ...provider,
  apiKey: provider.apiKey ?? process.env[provider.apiKeyEnv ?? ''],
}, provider.defaultModel)
```

### OpenAI-Compatible HTTP

```ts
import { createModelAdapter } from 'lannr-core/providers'

const model = createModelAdapter({
  id: 'openai',
  type: 'openai-compatible',
  model: 'gpt-4.1',
  baseURL: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY,
  endpoint: 'chat-completions',
})
```

Supported endpoint modes:

| Endpoint | API path |
| --- | --- |
| `responses` | `/v1/responses` |
| `chat-completions` | `/v1/chat/completions` |
| `completions` | `/v1/completions` |

`LANNR_API_KEY` is used when `apiKey` is omitted.

## Runners

### Node Runner

```ts
import { nodeRunner } from 'lannr-core/runner-node'

const runner = nodeRunner({
  timeoutMs: 30_000,
  memoryLimitMb: 128,
})
```

The Node runner executes programs with bound functions and a restricted global surface. It disables string and WASM code generation in the VM context and races execution against the configured timeout.

### WASM Runner

```ts
import { wasmRunner } from 'lannr-core/runner-wasm'

const runner = wasmRunner()
```

The package declares QuickJS WASM as its backend dependency. The current exported runner accepts the same `VaultRunner` contract.

### Edge Runner

```ts
import { edgeRunner } from 'lannr-core/runner-edge'

const runner = edgeRunner({
  endpoint: 'https://example.com/lannr/execute',
  headers: { authorization: `Bearer ${process.env.EDGE_TOKEN}` },
})
```

The edge runner sends:

```ts
{
  program: string,
  opts: ExecOptions,
  bindings: string[]
}
```

The remote bridge is responsible for exposing equivalent bindings and returning `{ result }`.

## Memory and Routines

A Routine is a saved, versioned program with trust metadata. Routines can be selected for future runs and called like tools.

```ts
import { FileMemoryStore, HttpMemoryStore } from 'lannr-extras/memory'

const memory = new FileMemoryStore('.lannr/memory')

// Or use an HTTP-backed store for shared/remote memory:
// const memory = new HttpMemoryStore('https://memory.example.com', { authorization: `Bearer ${token}` })

const lannr = createLannr({
  runner: nodeRunner(),
  model,
  tools,
  memory,
})
```

With memory enabled, Lannr:

1. Lists routines with at least `provisional` trust.
2. Uses `model.select()` when available, otherwise a name/tag heuristic.
3. Injects selected routines into the system prompt as `$routineName`.
4. Exposes `$saveRoutine` and `$patchRoutine`.

### Trust Progression

| Level | Condition | Behavior |
| --- | --- | --- |
| `draft` | Newly saved or below thresholds | Stored but not selected by default |
| `provisional` | At least 5 runs and at least 85% success | Eligible for prompt injection |
| `trusted` | At least 50 runs and at least 93% success | Eligible for direct routine use |
| `pinned` | Human-approved | Preserved by run recording |

Routine run outcomes are recorded when `lannr.runRoutine()` executes a routine and the memory store implements `recordRun()`.

### Saving Routines

The agent can save the current program:

```ts
await $saveRoutine({
  name: 'fetchWeeklyNpmReport',
  description: 'Fetch and rank NPM packages for a weekly report',
  tags: ['npm', 'report'],
})
```

Newly saved routines start as `draft`.

### Running Routines Directly

```ts
const routine = await memory.get('routine-id')
if (!routine) throw new Error('Missing routine')

const result = await lannr.runRoutine(routine, { query: 'state management' })
```

`runRoutine()` validates the input, binds `$input`, executes the routine program, validates output, and records trust success/failure when possible.

### Patching Routines

```ts
await memory.patch('routine-id', {
  patch: [
    '--- a/routine',
    '+++ b/routine',
    '@@ -1,1 +1,1 @@',
    '-return 1',
    '+return 2',
  ].join('\n'),
  reason: 'Update computed value',
  expectedVersion: 1,
})
```

The patch pipeline:

1. Applies the unified diff.
2. Parses the patched program.
3. Runs an optional `trialRun(program)` hook.
4. Commits the new version.

Failed diffs and failed validation attempts are recorded in the routine changelog with `outcome: 'failure'`.

### Rollback

```ts
import { rollbackRoutine } from 'lannr-extras/memory'

await rollbackRoutine(memory, 'routine-id', 1)
```

CLI:

```sh
lannr memory rollback routine-id --to-version 1
```

## Dynamic Tool Discovery

Attach a router to make tools discoverable at runtime. The SDK stays
transport-agnostic: `createLannr()` accepts any object that implements the
`RouterLike` interface, so you can back discovery with a remote registry, a
local catalog, or an in-memory map.

```ts
interface RouterLike {
  discover(query: string, limit?: number): Promise<unknown[]>
  inspect(toolId: string): Promise<unknown>
  invoke(toolId: string, input: unknown): Promise<unknown>
}
```

```ts
const router: RouterLike = {
  async discover(query, limit = 10) {
    const res = await fetch(`https://api.example.com/discover?q=${encodeURIComponent(query)}&limit=${limit}`)
    return res.json()
  },
  async inspect(toolId) {
    return (await fetch(`https://api.example.com/tools/${toolId}`)).json()
  },
  async invoke(toolId, input) {
    return (await fetch(`https://api.example.com/tools/${toolId}/invoke`, {
      method: 'POST',
      body: JSON.stringify(input),
    })).json()
  },
}

const lannr = createLannr({
  runner,
  model,
  tools,
  router,
})
```

The agent receives:

```ts
const tools = await $discover('send a Slack message')
const schema = await $inspect('slack.sendMessage')
const result = await $invoke('slack.sendMessage', {
  channel: '#engineering',
  text: 'Build passed',
})
```

`$invoke({ toolId, input })` is also supported for compatibility.

## Execution Replay and Cache

Lannr can store completed executions as `ExecutionRecord`s. Records contain the program, resolved tool calls, result, confidence, events, and error details.

```ts
import { FileReplayStore, FileCache, MemoryCache } from 'lannr-core'

const lannr = createLannr({
  runner,
  model,
  tools,
  cache: new MemoryCache(),          // in-process, no persistence
  // cache: new FileCache('.lannr/cache'), // file-backed alternative
  replayStore: new FileReplayStore('.lannr/replay'),
})
```

Executions are content-addressed by:

1. Normalized program text.
2. Resolved tool inputs.

An execution is replayable only when every called tool is cacheable. If any tool has `cacheTTL: 0` or `sideEffect: true`, the whole execution is not cached.

### Replay Stores

```ts
import { MemoryReplayStore, FileReplayStore } from 'lannr-core'

const memoryStore = new MemoryReplayStore()
const fileStore = new FileReplayStore('.lannr/replay')
```

`FileReplayStore` stores one JSON file per execution. `SqliteReplayStore` is currently an alias of `FileReplayStore`.

### Replay CLI

List executions:

```sh
lannr replay list --tool getWeather --has-error
```

Show an execution:

```sh
lannr replay show exec-id
lannr replay show exec-id --log-only
```

Re-run a stored execution:

```sh
lannr replay exec exec-id
```

Replay with a mocked binding:

```sh
lannr replay exec exec-id --mock '$getWeather={"temperature":42,"condition":"sunny"}'
```

Delete a record:

```sh
lannr replay delete exec-id
```

## Confidence

Lannr scores execution confidence from flags:

| Flag | Meaning |
| --- | --- |
| `tool_error` | Tool or execution failed |
| `schema_coercion` | Schema coercion was needed |
| `slow_execution` | Execution used more than 80% of timeout |
| `unknown_tool` | Unknown binding/tool |
| `empty_result` | Result was `null`, `undefined`, or empty array |
| `router_fallback` | Router fallback path was used |

```ts
import { confidence, scoreConfidence } from 'lannr-core'

scoreConfidence(['tool_error', 'empty_result'])
confidence(['slow_execution'])
```

## Failure Archaeology

Failure Archaeology compares a failing program with similar successful routines and produces a debugging hint.

```ts
import { runArchaeology } from 'lannr-core'

const result = await runArchaeology(program, error, memory, embedder)
console.log(result.hint)
```

When an execution fails and memory is attached, `lannr.run()` includes archaeology output in the tool-result payload.

Similarity is embedding-based when an `EmbeddingProvider` and routine embeddings are present. Otherwise Lannr falls back to token-overlap similarity.

## Reactive Routines

Reactive routines run saved routines without asking the model. They use `lannr.runRoutine()`.

```ts
import {
  LannrScheduler,
  InProcessEventBus,
  MemoryReactiveRoutineStore,
  schedule,
  on,
  onWebhook,
} from 'lannr-extras/scheduler'

const store = new MemoryReactiveRoutineStore()
const bus = new InProcessEventBus()
const scheduler = new LannrScheduler(lannr, store, bus, 10_000)
```

### Cron Trigger

```ts
await store.save(schedule('weekly-npm-report', {
  cron: '0 9 * * 1',
  routine: 'fetchWeeklyNpmReport',
  input: { query: 'state management', limit: 10 },
  sink: {
    type: 'slack',
    channel: '#engineering',
    webhookUrl: process.env.SLACK_WEBHOOK_URL!,
  },
}))
```

### One-Time Trigger

```ts
import { once } from 'lannr-extras/scheduler'

await store.save(once('send-welcome', {
  runAt: new Date('2025-01-01T09:00:00Z'),
  routine: 'sendWelcomeEmail',
  input: { userId: '123' },
  sink: { type: 'store' },
}))
```

### Interval Trigger

```ts
import { interval } from 'lannr-extras/scheduler'

await store.save(interval('health-check', {
  intervalMs: 60_000,
  routine: 'checkServiceHealth',
  input: {},
  sink: { type: 'store' },
}))
```

### Event Trigger

```ts
await store.save(on('pr-notifier', {
  event: 'github.pr.opened',
  routine: 'notifyOnNewPr',
  inputMapper: '(event) => ({ prUrl: event.pull_request.html_url })',
  sink: { type: 'store' },
}))

await bus.publish('github.pr.opened', {
  pull_request: { html_url: 'https://github.com/acme/repo/pull/1' },
})
```

### Webhook Trigger

```ts
const reactive = onWebhook('incoming-webhook', {
  routine: 'handleWebhookPayload',
  inputMapper: '(event) => ({ value: event.value })',
  secret: process.env.WEBHOOK_SECRET!,
  sink: { type: 'store' },
})

await store.save(reactive)

await scheduler.handleWebhook('incoming-webhook', { value: 21 }, process.env.WEBHOOK_SECRET!)
```

### Sinks

Supported sinks:

```ts
{ type: 'store' }
{ type: 'webhook', url: 'https://example.com/hook', headers: {} }
{ type: 'slack', channel: '#engineering', webhookUrl: 'https://hooks.slack.com/...' }
{ type: 'email', to: 'team@example.com', endpoint: 'https://mailer.example/send' }
```

Reactive routines track status, consecutive failures, next run time, and automatic disabling after `failureThreshold` failures.

## Devtools

```ts
import { ExecutionTimeline, MemoryBrowser } from 'lannr-extras/devtools'

const timeline = new ExecutionTimeline()

for await (const event of lannr.stream(messages)) {
  timeline.push(event)
}

console.log(timeline.summary())
console.log(timeline.byType('lannr:tool:call'))
```

Memory browser:

```ts
const summaries = await memory.list({ minTrust: 'draft' })
const browser = new MemoryBrowser(summaries)

browser.search('npm')
browser.byTrust('trusted')
browser.toJSON()
```

## Agent, Gateway, and Runtime Utilities

The CLI is built on top of SDK packages instead of private CLI-only implementations. Use these packages when you are building your own host, server, or local agent application:

```ts
import { readAgentRegistry, appendSessionTurn } from 'lannr-core/agents'
import { createLannrGateway } from 'lannr-core/gateway'

const registry = await readAgentRegistry()

const gateway = await createLannrGateway({
  async createRuntime(request) {
    const agent = registry.agents.find((item) => item.id === request.agent) ?? registry.agents[0]
    return {
      agent,
      provider: { id: 'default', defaultModel: 'gpt-4.1' },
      lannr, // your createLannr(...) instance
    }
  },
  async appendSessionTurn(runtime, request, turn) {
    await appendSessionTurn(runtime.agent, request.session, turn)
  },
})

const completion = await gateway.complete({
  agent: 'default',
  session: 'work-session',
  messages: [{ role: 'user', content: 'Summarize the repo' }],
})
```

`lannr-core/gateway` also exports `createContextEngine()`, `compressTrajectory()`, and `totalChars()` for long-running conversations that need deterministic context trimming or model-assisted summarization.

## Workspace, Browser, Checkpoint, and MCP Tools

Node hosts can opt into the same reusable tools the CLI uses without depending on the CLI UI:

```ts
import { createFileTools, createEditTools, createBashTools, createTodoTools, createCheckpointManager } from 'lannr-extras/workspace-tools'
import { createBrowserTools } from 'lannr-extras/browser'
import { loadMcpTools } from 'lannr-extras/mcp'

const ctx = { workspace: process.cwd(), agent, globalReach: false, session: 'default' }

const tools = [
  ...createFileTools(ctx),
  ...createEditTools(ctx),
  ...createBashTools(ctx),
  ...createTodoTools(ctx),
  ...createBrowserTools(ctx),
  ...(await loadMcpTools(ctx)),
]

const checkpoints = createCheckpointManager(agent)
```

These packages are optional: keep using `lannr-core` alone for embedded runtimes, tests, or non-filesystem environments.

## CLI

Run a prompt against an OpenAI-compatible endpoint:

```sh
lannr run "Read package.json" \
  --model gpt-4.1 \
  --base-url https://api.openai.com/v1 \
  --api-key "$OPENAI_API_KEY"
```

Memory:

```sh
lannr memory list
lannr memory inspect routine-id
lannr memory rollback routine-id --to-version 1
```

Routine execution:

```sh
lannr routine run routine-name --input '{"value":21}'
```

Replay:

```sh
lannr replay list
lannr replay show exec-id
lannr replay exec exec-id --mock '$getWeather={"temperature":42}'
lannr replay delete exec-id
```

Devtools:

```sh
lannr devtools
```

## Testing Patterns

Use a deterministic test model and `nodeRunner()` for runtime tests.

```ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createLannr, tool } from 'lannr-core'
import { nodeRunner } from 'lannr-core/runner-node'

it('runs generated code with a bound tool', async () => {
  const lannr = createLannr({
    runner: nodeRunner(),
    model: {
      async complete() {
        return '<program>\nreturn await $double({ value: 21 })\n</program>'
      },
    },
    tools: [
      tool({
        name: 'double',
        input: z.object({ value: z.number() }),
        output: z.number(),
        handler: ({ value }) => value * 2,
      }),
    ],
  })

  const result = await lannr.run([{ role: 'user', content: 'double 21' }])
  expect(result.answer).toBe('The value is 42.')
})
```

## Operational Notes

Keep tool handlers deterministic when possible. Replay and cache behavior is strongest when tools return stable results for stable inputs.

Mark side-effecting tools:

```ts
tool({
  name: 'sendEmail',
  sideEffect: true,
  cacheTTL: 0,
  input,
  output,
  handler,
})
```

Prefer small, typed outputs. The entire execution result is returned to the model as a tool-result message.

Use `Promise.all` in model instructions and examples for independent calls. Lannr enables parallelism, but the program still controls when promises are awaited.

Use memory only for programs worth reusing. Draft routines are stored but not injected by default; a routine must earn trust through successful execution.

Use replay stores in development and staging. Replay records are useful for debugging model-written code, tool schema changes, and transient API failures.

## Current Implementation Notes

The public SDK surface is implemented around the `VaultRunner` interface, so runners can be replaced without changing `createLannr()`.

`lannr-core/runner-node` currently uses a constrained `node:vm` context with string and WASM code generation disabled. It is useful for local execution control, but it is not a hardened security boundary. `lannr-core/runner-wasm` declares `quickjs-emscripten` and exposes the same runner contract. `lannr-core/runner-edge` is an HTTP bridge and requires a compatible remote executor.

`SqliteMemoryStore` and `SqliteReplayStore` are aliases of file-backed stores in this version.

## Repository Commands

```sh
pnpm test
pnpm typecheck
pnpm build
```
