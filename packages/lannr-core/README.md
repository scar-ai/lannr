<div align="center">

# 🧠 &nbsp;`lannr-core`

### **The code-native agentic runtime for TypeScript.**

*Stop asking models for one tool call at a time. Ask them for a program.*

[![npm](https://img.shields.io/npm/v/lannr-core?style=flat-square&logo=npm&color=cb3837)](https://www.npmjs.com/package/lannr-core)
[![Node](https://img.shields.io/badge/Node-isolated--vm-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](https://github.com/scar-ai/lannr/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-DOCS.md-3b82f6?style=flat-square)](https://github.com/scar-ai/lannr/blob/main/DOCS.md)

[**Install**](#-install) · [**Hello, Lannr**](#-hello-lannr--in-30-seconds) · [**Why programs?**](#-why-programs) · [**Exports**](#-the-export-surface) · [**Full docs**](https://github.com/scar-ai/lannr/blob/main/DOCS.md)

</div>

---

## ✨ What is it?

`lannr-core` is the runtime the entire Lannr stack is built on. Instead of playing 20 questions with your model — *pick a tool, get a result, ask again, repeat* — the model writes a **short TypeScript program**, `lannr-core` runs it inside an isolated **Vault**, and hands back the result.

One model call can orchestrate a dozen tools — in parallel, with real control flow, with exact arithmetic.

```ts
// What the model writes — real code, not 12 JSON tool calls:
const top = await $getTopProducts({ limit: 2 })
const ratings = await Promise.all(
  top.products.map((p) => $getProductRatings({ productId: String(p.id) })),
)
return top.products.map((p, i) => ({
  name: p.name,
  avg: ratings[i].ratings.reduce((s, r) => s + r.score, 0) / ratings[i].ratings.length,
}))
```

This is the SDK behind the [`lannr` CLI](https://github.com/scar-ai/lannr/blob/main/packages/lannr-cli/README.md). Embed the exact same runtime in your own product, server, or edge function.

---

## 📦 Install

```bash
pnpm add lannr-core zod
# optional capabilities (memory, scheduler, browser, MCP, devtools):
pnpm add lannr-extras
```

---

## 🚀 Hello, Lannr — in 30 seconds

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

---

## 🔁 Why programs?

That one change — code instead of one-shot JSON — unlocks everything:

| | |
| :-- | :-- |
| ⚡ **Parallelism** | `Promise.all` your tool calls. No more serial round-trips. |
| 🧠 **Routines** | Save successful programs. Replay them. Earn trust. Patch with diffs. |
| 🔁 **Replay & cache** | Content-addressed executions. Deterministic re-runs. Mock any binding. |
| 🗺 **Dynamic routing** | `$discover('send a slack message')` → inspect schema → invoke. At runtime. |
| 🔒 **Controlled execution** | Programs run through a constrained Node VM, QuickJS WASM, or an edge HTTP bridge. |
| 📊 **Confidence** | Every run is scored from execution flags (`tool_error`, `slow_execution`, `empty_result`, …). |

---

## 🌊 Stream every step

```ts
for await (const event of lannr.stream([{ role: 'user', content: 'Double 21.' }])) {
  if (event.type === 'lannr:program')   console.log(event.code)
  if (event.type === 'lannr:tool:call') console.log('→', event.tool, event.input)
  if (event.type === 'lannr:answer:delta') process.stdout.write(event.text)
}
```

---

## 🧩 The export surface

Stable subpath exports — import only what you need.

| Import | What it does |
| :-- | :-- |
| `lannr-core` | `createLannr()`, `tool()`, `Lannr`, replay stores, cache, `confidence`, program diffing, archaeology |
| `lannr-core/providers` | `createModelAdapter` — OpenAI-compatible, Anthropic, Google, Codex adapters + registry, rate limiting |
| `lannr-core/runner-node` | `nodeRunner()` — Vault runner using a constrained `node:vm` context |
| `lannr-core/runner-wasm` | QuickJS WASM runner |
| `lannr-core/runner-edge` | HTTP bridge runner for edge execution |
| `lannr-core/runner` | Shared `VaultRunner` contract |
| `lannr-core/agents` | Isolated agents, persisted sessions, memory paths, registry |
| `lannr-core/gateway` | Conversation gateway, OpenAI-style wrappers, context compaction, trajectory |

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
3. **Lannr scores confidence** and can store a content-addressed **replay record** for deterministic re-runs.

---

## 📖 Learn more

- **Full SDK reference** — runners, providers, replay, confidence, archaeology, gateway → [DOCS.md](https://github.com/scar-ai/lannr/blob/main/DOCS.md)
- **Add memory, scheduling, MCP, browser tools** → [`lannr-extras`](https://github.com/scar-ai/lannr/blob/main/packages/lannr-extras/README.md)
- **Just want a configured agent in your terminal?** → [`lannr-cli`](https://github.com/scar-ai/lannr/blob/main/packages/lannr-cli/README.md)
- **Project overview** → [README](https://github.com/scar-ai/lannr/blob/main/README.md)

---

<div align="center">

**Built for agents that ship.**

[Full docs →](https://github.com/scar-ai/lannr/blob/main/DOCS.md) · [Extras →](https://github.com/scar-ai/lannr/blob/main/packages/lannr-extras/README.md) · [CLI →](https://github.com/scar-ai/lannr/blob/main/packages/lannr-cli/README.md)

</div>
