<div align="center">

<img src="./banner.png" alt="Lannr — the code-native agentic runtime for TypeScript" width="690">

### **The code-native agentic runtime for TypeScript.**

*Stop asking models for one tool call at a time. Ask them for a program.*

[![pnpm](https://img.shields.io/badge/pnpm-workspace-f69220?style=flat-square&logo=pnpm)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-isolated--vm-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-DOCS.md-3b82f6?style=flat-square)](./DOCS.md)

[**Quick start**](#-quick-start-60-seconds) · [**The CLI**](#-the-lannr-cli--for-everyone) · [**The SDK**](#-the-lannr-sdk--for-builders) · [**Packages**](#-packages) · [**Full docs**](./DOCS.md)

</div>

---

## ✨ Why Lannr?

Traditional agents play 20 questions with your model — *pick a tool, get a result, ask again, repeat.* Every round-trip burns a model call. Every result is glued back into the prompt. Loops, math, and parallelism are faked one JSON blob at a time.

**Lannr flips the loop.** The model writes a **short TypeScript program**, Lannr runs it inside an isolated **Vault**, and hands back the result. One model call can orchestrate a dozen tools — in parallel, with real control flow, with exact arithmetic.

```ts
// What the model writes — real code, not 12 JSON tool calls:
const top = await $getTopProducts({ limit: 2 })
const ratings = await Promise.all(
  top.products.map((p) => $getProductRatings({ productId: String(p.id) }))
)
return top.products.map((p, i) => ({
  name: p.name,
  avg: ratings[i].ratings.reduce((s, r) => s + r.score, 0) / ratings[i].ratings.length,
}))
```

That one change unlocks everything:

|  |  |
| :-- | :-- |
| ⚡ **Parallelism** | `Promise.all` your tool calls. No more serial round-trips. |
| 🧠 **Routines** | Save successful programs. Replay them. Earn trust. Patch with diffs. |
| 🔁 **Replay & cache** | Content-addressed executions. Deterministic re-runs. Mock any binding. |
| 🛰 **Reactive** | Cron, events, and webhooks fire routines *without ever calling the model.* |
| 🔌 **MCP-native** | Plug in any MCP server. Tools appear as `$mcpCallTool` bindings inside the Vault. |
| 🗺 **Dynamic routing** | `$discover('send a slack message')` → inspect schema → invoke. At runtime. |
| 🔒 **Controlled execution** | Programs run through a constrained Node VM, QuickJS WASM, or an edge HTTP bridge. |

> **Two front doors, one runtime.** The **`lannr` CLI** gives anyone a configured agent with memory, routines, scheduling, and a TUI in 60 seconds. The **SDK** lets you embed that exact runtime in your own product.

---

## 🚀 Quick start (60 seconds)

```bash
# 1. Install and build from this workspace
pnpm install
pnpm --filter lannr-cli build

# 2. Link the CLI globally
cd packages/lannr-cli
pnpm setup # if pnpm has not configured a global bin directory yet
pnpm link

# You can also use npm for the global symlink after the pnpm build:
# npm link

# 3. Configure your first provider (Anthropic, OpenAI, Google, Codex, OpenRouter…)
lannr setup

# 4. Talk to it
lannr chat
```

That's it. You now have a fully wired agent with **memory, routines, MCP, scheduling, and an interactive TUI** — no glue code.

---

## ⚒ The Lannr CLI — *for everyone*

The CLI is the **front door** to the entire runtime. Every capability — providers, agents, memory, routing, scheduling, browser tools, MCP — is reachable from one binary: `lannr`.

```
  ⚒  lannr

  Getting started
    setup        First-time configuration wizard
    status       Show configured providers and agents
    doctor       Diagnose your install (exits 1 on problems)

  Chat & run
    chat         Open the interactive terminal UI (TUI)
    run          One-shot prompt → stdout
    resume       Resume a saved session

  Agents & memory
    agents       Isolated agents — add, ls, edit, bind, rm
    memory       Curated USER.md + MEMORY.md carried across sessions
    sessions     Browse saved chat sessions
    undo         Roll back the workspace to the last checkpoint

  Providers
    provider     Register, authenticate, and select model providers

  Automation
    routine      Saved Lannr programs — list, show, run, rollback
    schedule     Cron / interval / one-shot agent runs

  Servers & tools
    hub          Run the OpenAI-compatible gateway
    mcp          Manage MCP servers
    skills       Shared prompt/instruction sets
    tools        Configure optional webFetch / webSearch
    settings     View and edit runtime settings
```

### A guided tour

<details open>
<summary><b>🧙 <code>lannr setup</code> — onboarding in 60 seconds</b></summary>

```bash
$ lannr setup
? Which provider do you want to configure?  ❯ Anthropic
? API key?  ●●●●●●●●●●●●●●●●
? Default model?  claude-opus-4-8
✓ Saved provider 'anthropic'
✓ Created default agent
→ Try:  lannr chat
```

Fully scriptable for CI — every prompt has a flag:

```bash
lannr setup --non-interactive \
  --auth-choice openai --openai-api-key "$OPENAI_API_KEY" \
  --model gpt-4.1 --agent-name "Dev"
```

</details>

<details>
<summary><b>💬 <code>lannr chat</code> — the terminal UI</b></summary>

A streaming, multi-pane TUI built on **Ink**. Watch the model write programs, see tool calls fire in parallel, and stream answers — without leaving the terminal.

```bash
lannr chat --agent dev --session work
```

</details>

<details>
<summary><b>⚡ <code>lannr run</code> — one-shot prompts in a pipe</b></summary>

```bash
lannr run "Summarize the last 10 commits"
lannr run "Read package.json and list dependencies" --agent dev
echo "what failed?" | lannr run --agent oncall --model gpt-4.1
lannr run --session work "Continue working on the auth module"
```

</details>

<details>
<summary><b>🧠 <code>lannr memory</code> — curated agent context</b></summary>

```bash
lannr memory list                          # show MEMORY.md entries
lannr memory add "Prefers concise answers"
lannr memory add "User works in TypeScript" --user
lannr memory replace "Prefers concise" "Prefers very concise, no fluff"
lannr memory path                          # where it lives on disk
```

The agent carries `USER.md` + `MEMORY.md` across every session — like a colleague who actually remembers your preferences.

</details>

<details>
<summary><b>♻️ <code>lannr routine</code> — programs that earn trust</b></summary>

```bash
$ lannr routine list
  fetchWeeklyNpmReport   trusted      runs=128  ✓ 97%
  notifyOnNewPr          provisional  runs=7    ✓ 86%
  summarizeStandup       draft        runs=2    ✓ 50%

$ lannr routine run fetchWeeklyNpmReport --input '{"query":"state management"}'
$ lannr routine rollback fetchWeeklyNpmReport --to-version 3
```

Routines progress `draft → provisional → trusted → pinned` as they prove themselves across real runs.

</details>

<details>
<summary><b>🛰 <code>lannr schedule</code> — run without prompting</b></summary>

```bash
# Recurring, every 2 hours
lannr schedule add -d "Health check" -m "Check service health and report issues" --every 2h --agent dev

# Weekly cron
lannr schedule add -d "Weekly report" -m "Generate the weekly NPM report" --cron "0 9 * * 1"

# One-shot offset
lannr schedule add -d "Reminder" -m "Remind the team about the release" --in 30m

lannr schedule ls
lannr schedule run <id>      # fire once now, leaving the schedule intact
```

Schedules auto-disable after `--failure-threshold` consecutive failures.

</details>

<details>
<summary><b>🧑‍🤝‍🧑 <code>lannr agents</code> — isolated, routed, swappable</b></summary>

```bash
lannr agents add "Writer" anthropic --model claude-opus-4-8
lannr agents add "Oncall" openai    --model gpt-4.1
lannr agents bind --agent writer --bind "*.ts"
lannr agents ls
```

Every agent gets its **own** workspace, memory, routines, sessions, and tool routing — fully isolated.

</details>

<details>
<summary><b>🔌 <code>lannr mcp</code> — plug in any MCP server</b></summary>

```bash
lannr mcp add filesystem \
  --command npx --arg @modelcontextprotocol/server-filesystem --arg /tmp --cwd /tmp
lannr mcp ls
lannr mcp tools filesystem
```

Inside the Vault, the agent now has `$mcpCallTool('filesystem', 'read_file', { … })`.

</details>

<details>
<summary><b>🛡 <code>lannr hub</code> — OpenAI-compatible gateway</b></summary>

```bash
$ lannr hub start --port 8080
✓ Listening on http://localhost:8080

# Point any OpenAI SDK at it
$ curl http://localhost:8080/v1/chat/completions \
    -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"hi"}]}'
```

Drop-in compatible with anything that speaks OpenAI's API — but backed by the full Lannr runtime: agents, memory, routines, and replay.

</details>

<details>
<summary><b>🩺 <code>lannr doctor</code> & <code>lannr import</code> — operate with confidence</b></summary>

```bash
lannr doctor                 # health-checks providers, env vars, agent wiring
lannr import hermes          # migrate providers + agents from another platform
lannr import openclaw --dry-run
```

</details>

📖 **Every command, every flag → [`packages/lannr-cli/CLI.md`](./packages/lannr-cli/CLI.md)**

---

## 🧩 The Lannr SDK — *for builders*

The same runtime the CLI is built on, as composable TypeScript packages. Embed agents in your own product, server, or edge function.

```bash
pnpm add lannr-core zod
# optional capabilities (memory, scheduler, browser, MCP, devtools):
pnpm add lannr-extras
```

### Hello, Lannr — in 30 seconds

```ts
import { createLannr, tool } from 'lannr-core'
import { createModelAdapter } from 'lannr-core/providers'
import { nodeRunner } from 'lannr-core/runner-node'
import { z } from 'zod'

const double = tool({
  name: 'double',
  input: z.object({ value: z.number() }),
  output: z.number(),
  handler: ({ value }) => value * 2,
})

const lannr = createLannr({
  runner: nodeRunner(),
  model: createModelAdapter({
    id: 'openai',
    type: 'openai-compatible',
    model: 'gpt-4.1',
    baseURL: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    endpoint: 'chat-completions',
  }),
  tools: [double],
})

const { answer } = await lannr.run([
  { role: 'user', content: 'double 21 three times in parallel' },
])
```

The model writes one program…

```ts
return await Promise.all([
  $double({ value: 21 }),
  $double({ value: 21 }),
  $double({ value: 21 }),
])
```

**One model call. Three parallel tool calls. Exact arithmetic.** That's Lannr.

### Stream every step

```ts
for await (const event of lannr.stream([{ role: 'user', content: 'Double 21.' }])) {
  if (event.type === 'lannr:program')      console.log(event.code)
  if (event.type === 'lannr:tool:call')    console.log('→', event.tool, event.input)
  if (event.type === 'lannr:answer:delta') process.stdout.write(event.text)
}
```

### Give it a memory that earns trust

```ts
import { FileMemoryStore } from 'lannr-extras/memory'

const lannr = createLannr({
  runner: nodeRunner(),
  model,
  tools,
  memory: new FileMemoryStore('.lannr/memory'),
})
// Now the agent can $saveRoutine(...) and $patchRoutine(...),
// and proven routines get injected into future runs automatically.
```

📖 **The complete SDK reference — runners, providers, replay, confidence, archaeology, gateway → [`DOCS.md`](./DOCS.md)**

---

## 📦 Packages

The SDK ships as **two** packages with stable subpath exports; the CLI is published from a third.

| Package | Import surface | What it does |
| :-- | :-- | :-- |
| **`lannr-cli`** | `lannr` (binary) | **The CLI** — front door to everything below |
| **`lannr-core`** | `lannr-core` | `createLannr()`, `tool()`, replay, cache, confidence, archaeology |
| | `lannr-core/providers` | OpenAI-compatible, Anthropic, Google, Codex adapters + registry |
| | `lannr-core/runner-node` | Node Vault runner using a constrained `node:vm` context |
| | `lannr-core/runner-wasm` | QuickJS WASM runner |
| | `lannr-core/runner-edge` | HTTP bridge runner for edge execution |
| | `lannr-core/agents` | Isolated agents, persisted sessions, memory paths |
| | `lannr-core/gateway` | Conversation gateway, OpenAI-style wrappers, context compaction |
| **`lannr-extras`** | `lannr-extras/memory` | Routine persistence, trust tracking, diff patching, rollback |
| | `lannr-extras/scheduler` | Cron, interval, event, and webhook reactive routines |
| | `lannr-extras/workspace-tools` | Files, edits, bash, todos, checkpoints |
| | `lannr-extras/browser` | Chrome/CDP browser automation |
| | `lannr-extras/mcp` | MCP stdio client, registry, and tool bridge |
| | `lannr-extras/devtools` | Execution timeline + memory browser |

---

## 🔬 How it works

```
┌──────────────────────────────────────────────────────────────┐
│  User message                                                  │
└─────────────────────────────┬────────────────────────────────-┘
                              ▼
                   ┌──────────────────────┐
                   │    Lannr runtime     │  ← memory, router, MCP
                   └──────────┬───────────┘
                              ▼
                   Model writes a TS program
                              │
                              ▼
                   ┌──────────────────────┐
                   │       🔒 Vault        │  ← $tool, $discover,
                   │   (Node VM /         │     $mcpCallTool,
                   │    QuickJS / edge)   │     $saveRoutine
                   └──────────┬───────────┘
                              ▼
               Tool calls fire (parallel, cached)
                              │
                              ▼
                Result + confidence + replay record
```

1. **The model writes a program**, wrapped in `<program>…</program>`. Every tool `getWeather` is exposed inside the Vault as `$getWeather`.
2. **The Vault executes it** in a sandbox with a restricted global surface and a hard timeout.
3. **Lannr scores confidence** from execution flags (`tool_error`, `slow_execution`, `empty_result`, …) and can store a content-addressed **replay record** for deterministic re-runs.

Want the full picture — `tool()` fields, the `VaultRunner` contract, trust progression, sinks, Failure Archaeology, every CLI flag? → **[DOCS.md](./DOCS.md)**

---

## 🛠 Develop

This repo is a **pnpm workspace**. The CLI in `packages/lannr-cli/` consumes `lannr-core` and `lannr-extras` via `workspace:*`.

```sh
pnpm install
pnpm build       # tsc -b packages/*
pnpm test        # vitest
pnpm typecheck
```

---

<div align="center">

**Built for agents that ship.**

[Full documentation →](./DOCS.md) · [CLI reference →](./packages/lannr-cli/CLI.md)

</div>
