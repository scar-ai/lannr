# 🧰 &nbsp;`lannr-extras`

### **Batteries for the Lannr runtime.**

*Memory that earns trust, reactive scheduling, workspace tools, a browser, and MCP — all opt-in.*

[![npm](https://img.shields.io/npm/v/lannr-extras?style=flat-square&logo=npm&color=cb3837)](https://www.npmjs.com/package/lannr-extras)
[![Node](https://img.shields.io/badge/Node-isolated--vm-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](https://github.com/scar-ai/lannr/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-DOCS.md-3b82f6?style=flat-square)](https://github.com/scar-ai/lannr/blob/main/DOCS.md)

[**Install**](#-install) · [**Modules**](#-the-module-surface) · [**Tour**](#-a-guided-tour) · [**Full docs**](https://github.com/scar-ai/lannr/blob/main/DOCS.md)

---

## ✨ What is it?

[`lannr-core`](https://github.com/scar-ai/lannr/blob/main/packages/lannr-core/README.md) is the runtime: the model writes a TypeScript program, the Vault runs it. `lannr-extras` is everything that makes that runtime feel like a colleague — **persistent memory, routines that earn trust, reactive scheduling, real workspace tools, a browser, and MCP** — each behind its own subpath export so you only pull in what you use.

It's the same capability set the [`lannr` CLI](https://github.com/scar-ai/lannr/blob/main/packages/lannr-cli/README.md) ships, exposed as composable TypeScript.

---

## 📦 Install

```bash
pnpm add lannr-extras lannr-core zod
```

`lannr-extras` builds on `lannr-core` — install both.

---

## 🧩 The module surface

Import only the modules you need:

| Import | What it does |
| :-- | :-- |
| `lannr-extras/memory` | `FileMemoryStore` / `HttpMemoryStore` — routine persistence, trust tracking, diff patching, rollback |
| `lannr-extras/scheduler` | `LannrScheduler`, cron / interval / once / event / webhook reactive routines, sinks |
| `lannr-extras/workspace-tools` | Files, edits, bash, unified diffs, todos, checkpoints |
| `lannr-extras/browser` | Chrome/CDP browser automation with URL-safety policy |
| `lannr-extras/mcp` | MCP stdio client, registry, and tool bridge |
| `lannr-extras/devtools` | `ExecutionTimeline` + `MemoryBrowser` |

---

## 🎒 A guided tour

<details open>
<summary><b>🧠 <code>memory</code> — give it a memory that earns trust</b></summary>

```ts
import { createLannr } from 'lannr-core'
import { FileMemoryStore } from 'lannr-extras/memory'

const lannr = createLannr({
  runner,
  model,
  tools,
  memory: new FileMemoryStore('.lannr/memory'),
})
// Now the agent can $saveRoutine(...) and $patchRoutine(...),
// and proven routines get injected into future runs automatically.
```

Routines graduate `draft → provisional → trusted → pinned` as they prove themselves across real runs — and `rollbackRoutine(store, id, toVersion)` reverts a bad version.

</details>

<details>
<summary><b>🛰 <code>scheduler</code> — run routines without the model</b></summary>

```ts
import { schedule, once, on, onWebhook, LannrScheduler } from 'lannr-extras/scheduler'

const daily   = schedule('npm-report', { cron: '0 9 * * *', routine: 'weeklyReport', input: {} })
const reminder = once('release', { runAt: '2026-06-10T09:00:00Z', routine: 'changelog', input: {} })
const onDeploy = on('notify', { event: 'deploy.succeeded', routine: 'notify', inputMapper: '(e) => ({ sha: e.sha })' })
const onPush   = onWebhook('build', { routine: 'build', inputMapper: '(e) => ({ ref: e.ref })', secret: process.env.WEBHOOK_SECRET })
```

Cron, intervals, one-shots, local events, and webhooks fire saved routines *without ever calling the model.* Results flow to a **sink**: `store`, `slack`, `webhook`, or `email`.

</details>

<details>
<summary><b>🛠 <code>workspace-tools</code> — files, edits, bash, checkpoints</b></summary>

```ts
import {
  createFileTools,
  createEditTools,
  createBashTools,
  createCheckpointManager,
} from 'lannr-extras/workspace-tools'

const ctx = { workspace, globalReach: false }
const tools = [
  ...createFileTools(ctx),
  ...createEditTools(ctx),
  ...createBashTools(ctx),
]

// file-level checkpoints — the engine behind `lannr undo`
const checkpoints = createCheckpointManager({ workspace, agentDir })
```

Real read/write/edit/patch, sandboxed bash, and file-level checkpoints (the engine behind `lannr undo`).

</details>

<details>
<summary><b>🌐 <code>browser</code> — Chrome/CDP automation</b></summary>

```ts
import { createBrowserTools } from 'lannr-extras/browser'

const tools = createBrowserTools({ workspace, globalReach: false })
```

Navigation and interaction tools backed by Chrome DevTools Protocol, with a configurable URL-safety policy (`setUrlSafetyPolicy`).

</details>

<details>
<summary><b>🔌 <code>mcp</code> — plug in any MCP server</b></summary>

```ts
import { upsertMcpServer } from 'lannr-extras/mcp/registry'
import { loadMcpTools } from 'lannr-extras/mcp/bridge'

// Register a stdio MCP server in the registry…
await upsertMcpServer({ id: 'filesystem', command: 'npx', args: ['@modelcontextprotocol/server-filesystem', '/tmp'] })

// …and surface its tools inside the Vault as
// $mcpCallTool('filesystem', 'read_file', { … }).
const mcpTools = await loadMcpTools()
```

A stdio MCP **client** (`McpStdioClient`), a **registry** (`readMcpRegistry` / `upsertMcpServer` / `removeMcpServer`), and a **bridge** (`loadMcpTools`) that surfaces remote tools as Vault bindings.

</details>

<details>
<summary><b>🔭 <code>devtools</code> — see what happened</b></summary>

```ts
import { ExecutionTimeline, MemoryBrowser } from 'lannr-extras/devtools'
```

Inspect the execution timeline and browse stored memory while debugging.

</details>

---

## 📖 Learn more

- **The runtime these extras plug into** → [`lannr-core`](https://github.com/scar-ai/lannr/blob/main/packages/lannr-core/README.md)
- **Full SDK reference** — trust progression, sinks, Failure Archaeology, replay → [DOCS.md](https://github.com/scar-ai/lannr/blob/main/DOCS.md)
- **A configured agent in your terminal** → [`lannr-cli`](https://github.com/scar-ai/lannr/blob/main/packages/lannr-cli/README.md)
- **Project overview** → [README](https://github.com/scar-ai/lannr/blob/main/README.md)

---

<div align="center">

**Built for agents that ship.**

[Full docs →](https://github.com/scar-ai/lannr/blob/main/DOCS.md) · [Core →](https://github.com/scar-ai/lannr/blob/main/packages/lannr-core/README.md) · [CLI →](https://github.com/scar-ai/lannr/blob/main/packages/lannr-cli/README.md)

</div>
