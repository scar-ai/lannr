<div align="center">

# ⚒ &nbsp;`lannr`

### **The code-native agentic runtime — in your terminal.**

*One binary. A fully wired agent with memory, routines, scheduling, MCP, and a TUI — in 60 seconds.*

[![npm](https://img.shields.io/npm/v/lannr-cli?style=flat-square&logo=npm&color=cb3837)](https://www.npmjs.com/package/lannr-cli)
[![Node](https://img.shields.io/badge/Node-isolated--vm-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](../../LICENSE)
[![CLI reference](https://img.shields.io/badge/reference-CLI.md-3b82f6?style=flat-square)](./CLI.md)

[**Install**](#-install) · [**Quick start**](#-quick-start-60-seconds) · [**Commands**](#-the-command-surface) · [**Guided tour**](#-a-guided-tour) · [**Full reference**](./CLI.md)

</div>

---

## ✨ Why the CLI?

Traditional agents play 20 questions with your model — *pick a tool, get a result, ask again, repeat.* Every round-trip burns a model call.

**Lannr flips the loop.** The model writes a **short TypeScript program**, Lannr runs it inside an isolated **Vault**, and hands back the result. One model call can orchestrate a dozen tools — in parallel, with real control flow, with exact arithmetic.

The `lannr` CLI is the **front door** to that entire runtime. Every capability — providers, agents, memory, routing, scheduling, browser tools, MCP — is reachable from one binary. No glue code, no config spelunking.

> 🪄 **You don't even have to learn the commands.** Lannr agents understand the whole CLI. Ask in plain English mid-conversation — *"add the filesystem MCP server pointing to /tmp"*, *"remember that I prefer TypeScript"*, *"schedule a standup summary at 9 AM"* — and the agent runs the right command for you.

---

## 📦 Install

```bash
pnpm add -g lannr-cli
# or: npm i -g lannr-cli
```

The binary is `lannr`. Keep it current with:

```bash
lannr update          # pull the latest published version
```

<details>
<summary><b>Building from the workspace instead</b></summary>

```bash
pnpm install
pnpm --filter lannr-cli build
cd packages/lannr-cli
pnpm link             # or: npm link
```

</details>

---

## 🚀 Quick start (60 seconds)

```bash
# 1. Configure your first provider (Anthropic, OpenAI, Google, Codex, OpenRouter…)
lannr setup

# 2. Talk to it
lannr chat
```

That's it. You now have a fully wired agent with **memory, routines, MCP, scheduling, and an interactive TUI**.

```bash
$ lannr setup
? Which provider do you want to configure?  ❯ Anthropic
? API key?  ●●●●●●●●●●●●●●●●
? Default model?  claude-opus-4-8
✓ Saved provider 'anthropic'
✓ Created default agent
→ Try:  lannr chat
```

---

## 🧭 The command surface

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
    reactive     Bind routines to cron, events, and webhooks

  Servers & tools
    hub          Run the OpenAI-compatible gateway
    mcp          Manage MCP servers
    plugins      Register local tool modules
    skills       Shared prompt/instruction sets
    tools        Configure optional webFetch / webSearch
    settings     View and edit runtime settings
```

---

## 🎒 A guided tour

<details open>
<summary><b>💬 <code>lannr chat</code> — the terminal UI</b></summary>

A streaming, multi-pane TUI built on **Ink**. Watch the model write programs, see tool calls fire in parallel, and stream answers — without leaving the terminal.

```bash
lannr chat
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
lannr memory list dev                                # show MEMORY.md entries
lannr memory add  dev "Prefers concise answers"
lannr memory add  dev "User works in TypeScript" --user
lannr memory replace dev "Prefers concise" "Prefers very concise, no fluff"
lannr memory path dev                                # where it lives on disk
```

Each agent carries `USER.md` + `MEMORY.md` across every session — like a colleague who actually remembers your preferences.

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

Routines graduate `draft → provisional → trusted → pinned` as they prove themselves across real runs. The agent distills them automatically — you rarely write one by hand.

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
<summary><b>🩺 <code>lannr doctor</code> &amp; <code>lannr import</code> — operate with confidence</b></summary>

```bash
lannr doctor                 # health-checks providers, env vars, agent wiring
lannr import hermes          # migrate providers + agents from another platform
lannr import openclaw --dry-run
```

`lannr doctor` exits `1` if anything is wrong — perfect for CI gates.

</details>

---

## 🤖 Built for CI, too

Every interactive prompt has a flag. Wire `lannr` straight into pipelines:

```bash
lannr setup --non-interactive \
  --auth-choice openai --openai-api-key "$OPENAI_API_KEY" \
  --model gpt-4.1 --agent-name "Dev"

lannr run "Review the diff and flag risky changes" --agent dev --json
lannr doctor          # exits 1 on any problem
```

---

## 📖 Full reference

Every command, every flag, every alias lives in **[`CLI.md`](./CLI.md)**.

Want the runtime internals — the `Vault`, trust progression, replay records, the SDK behind the binary? See the workspace **[README](../../README.md)** and **[DOCS.md](../../DOCS.md)**.

---

<div align="center">

**Built for agents that ship.**

[CLI reference →](./CLI.md) · [Workspace README →](../../README.md) · [Full docs →](../../DOCS.md)

</div>
