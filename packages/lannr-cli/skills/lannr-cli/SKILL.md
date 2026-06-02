---
name: lannr-cli
description: Your self-knowledge skill — the complete reference for the Lannr CLI (`lannr`) you yourself run on. Covers installing/updating/uninstalling the CLI, setup and onboarding, providers, agents, skills, memory, scheduling, routines, MCP, plugins, and on-disk state. Open it PROACTIVELY and WITHOUT being asked whenever a task touches Lannr itself: installing or updating `lannr`, first-time setup, inspecting or changing your own configuration, creating/editing agents, managing providers/skills/MCP, scheduling work, or explaining how Lannr operates. The user never has to tell you to read this — if the question is about Lannr, this is your source of truth.
version: 2
---

# Lannr CLI

Lannr is a code-native agentic runtime. Instead of emitting one JSON tool call at
a time, an agent writes a short TypeScript program that calls `$tool` bindings,
which Lannr runs in a sandbox and feeds the result back into the conversation.

`lannr` is the CLI that drives this runtime locally: it manages providers, agents,
skills, memory, scheduling, reactive routines, MCP servers, and plugins. This
skill documents that surface so you can act on your own configuration when a task
calls for it.

> You are a Lannr agent. Everything below is state you can read and change with
> `$bash` (running the `lannr ...` commands) plus your file tools. Prefer the
> dedicated `lannr` subcommands over editing JSON by hand — they validate input
> and keep registries consistent.
>
> **This is your self-knowledge.** Whenever a task is about Lannr itself —
> installing or updating the CLI, running setup, configuring providers/agents,
> scheduling, or explaining how any of it works — consult this skill on your own.
> Do not wait for the user to point you here, and never tell the user to "open the
> skill"; just answer from it.

## Installing, updating & uninstalling the CLI

The CLI is published to npm as `lannr-cli` (binary: `lannr`).

- **Install:** `pnpm add -g lannr-cli` (or `npm i -g lannr-cli`). From a source
  checkout of the workspace: `pnpm --filter lannr-cli build` then `pnpm link` /
  `npm link` in `packages/lannr-cli`.
- **Update:** `lannr update` — pulls the latest published version of the global
  CLI in place.
- **Uninstall:** `lannr uninstall` stops the background hub and deletes the data
  dir (`~/.lannr` / `$LANNR_HOME`). Flags: `--dry-run`, `--yes`, `--keep-data`
  (keep `~/.lannr`), `--remove-binary` (also drop the global bin), `--json`. The
  confirm prompt requires typing `uninstall` (or `yes`/`y`).
- **Verify a fresh install:** `lannr doctor` (exits `1` on problems) and
  `lannr status`.

## State on disk

Everything lives under `~/.lannr/`:

| Path | Contents |
| --- | --- |
| `~/.lannr/agents.json` | Registry of all agents |
| `~/.lannr/_last-agent.json` | Last-used agent pointer |
| `~/.lannr/agents/<id>/` | Per-agent state directory (`agentDir`) |
| `~/.lannr/agents/<id>/workspace/` | Default agent workspace (files the agent edits) |
| `~/.lannr/agents/<id>/sessions/` | Saved chat sessions |
| `~/.lannr/agents/<id>/skills/<name>/SKILL.md` | Agent-bound skills available only to that agent |
| `~/.lannr/skills/<name>/SKILL.md` | Installed shared skills (this file is one) |
| `~/.lannr/providers*` | Registered model providers |
| MCP / plugin / schedule / routine stores | Managed via their subcommands |

An agent's workspace and `agentDir` are reported in your own system prompt under
**Workspace context**. By default an agent is sandboxed to its workspace unless it
was created with `--globalreach`.

### Workspace instruction & memory files

At prompt-build time Lannr reads these files from the agent workspace, in order,
and appends any non-empty ones to the system prompt:

`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`,
`BOOTSTRAP.md`

On each turn it also injects startup memory from `MEMORY.md` and `USER.md` (in the
workspace) plus the agent memory dir's `MEMORY.md` and a dated daily file. Editing
these files is the durable way to change an agent's behavior, identity, or stored
knowledge.

## Tools available to you (the running agent)

Inside a `<program>` you call these as `$name(...)`. The user never sees program
code — never quote or paraphrase it in your prose.

**Files & shell**
- `$readFile`, `$writeFile`, `$editFile`, `$applyPatch` — text file I/O. Prefer
  `$editFile` for existing files, `$writeFile` only for new files, `$applyPatch`
  when you already hold a unified diff.
- `$bash` — all shell-style ops: `ls`, `find`, `grep`/`rg`, `cat`, moving files,
  inspecting binaries/PDFs, and running `lannr ...` subcommands.

**Web**
- `$webFetch`, `$webSearch` — optional; enabled via `lannr tools setup`.

**Browser**
- Browser automation tools (navigation/interaction) when configured.

**Agents (self & others)**
- `$listAgents` — enumerate registered agents.
- `$spawnAgent` — delegate a focused subtask to another agent. Spawned agents do
  NOT inherit the conversation; pass complete context in the prompt.

**Scheduling**
- `$scheduleAgentTurn` — run a natural-language prompt later (one trigger:
  `every` / `in` / `runAt` / `cron`).
- `$listScheduledActions`, `$cancelScheduledAction`.
- `$scheduleRoutine`, `$scheduleToolCall` — schedule a saved routine or a single
  tool call.
- In listings: `status=due` means queued/overdue, not done. Only
  `lastRunStatus=success` or `status=completed` means completed.

**Memory**
- `$memory` — curated cross-session notes. `target='user'` for facts about the
  person; `target='memory'` for your own notes (conventions, decisions, lessons).
  Save the moment you learn something durable; skip ephemerals and secrets.
- `$appendMemory` — append-only memory write.

**Workflow**
- `$todo` — track multi-step work.
- `$checkpointSnapshot`, `$checkpointList`, `$checkpointRestore` — workspace
  checkpoints (also exposed as `lannr undo`).
- `$clarify` — ask the user a focused question when genuinely blocked.

MCP-server tools and plugin tools are merged in dynamically when configured.

## Command reference

Run `lannr <command> --help` for full flags. Common ones:

### Setup & status
- `lannr setup` / `lannr onboard` — initialize provider config and a first agent.
- `lannr doctor` — check local setup health.
- `lannr status` — show runtime status.
- `lannr tools setup` — configure optional `webFetch` / `webSearch`.

### Chat & runs
- `lannr chat` — interactive terminal UI.
- `lannr run [prompt...]` — one-shot prompt. Flags: `-a/--agent`, `-p/--provider`,
  `-m/--model`, `--session <id>`.
- `lannr resume <session>` — resume a saved session. Flags: `--message`,
  `-a/--agent`, `-p/--provider`, `-m/--model`, `--history-limit`,
  `--no-tools`, `--thinking`.
- `lannr sessions list` — list saved sessions.
- `lannr undo` — restore the workspace to before the last agent turn.

### Agents
- `lannr agents ls [--bindings] [--json]` — list agents.
- `lannr agents add <name> <provider> [opts]` — create an isolated agent.
  Provider is required. Notable opts: `--description`, `--instructions`,
  `--workspace`, `--agent-dir`, `--alias` (repeatable), `--bind` (routing,
  repeatable), `--denyskills <csv>` (repeatable), `--globalreach`, `--default`,
  `--non-interactive`.
- `lannr agents edit [name]` — interactive editor.
- `lannr agents update <name> [opts]` (alias `set`) — non-interactive edits:
  `--name`, `--description`, `--instructions`, `--provider`, `--model`,
  `--alias`, `--bind`, `--denyskills`, `--globalreach` / `--no-globalreach`,
  `--default`.

To make yourself behave differently, prefer `lannr agents update <your-id> ...`
or edit your workspace instruction files over hand-editing `agents.json`.

### Providers
- `lannr provider ls [--available] [--json]` — list providers (or presets).
- `lannr provider primary [id]` — show or set the default provider.
- `lannr provider login <id>` — authenticate a provider.
- `lannr provider new [id] [opts]` (alias `add`) — create/update: `--name`,
  `--type`, `--base-url`, `--api-key`, `--api-key-env`, `--model`,
  `--models <csv>`, `--endpoint` (`chat-completions` | `responses` |
  `codex-responses` | `completions`), `--alias`. `--model` is the default model;
  `--models` seeds additional saved models for the same provider.
- `lannr provider models ls <id>` — list saved models for a provider; the
  default model is marked with `*`.
- `lannr provider models add <id> <model...>` — add one or more models to an
  existing provider without creating another provider entry.
- `lannr provider models rm <id> <model...>` — remove saved models from a
  provider. If the default model is removed, Lannr picks the first remaining
  model as the new default.
- `lannr provider models default <id> <model>` — set the provider's default
  model and add it to the saved model list if needed.
- `lannr provider rm [id]` — remove a provider.

### Skills (what this file is part of)
- `lannr skills list` (alias `ls`) `[--json]` — list installed shared skills and
  the skills root.
- `lannr skills add <path> [--agent <id>] [--force]` (alias `install`) — install
  a directory that contains a `SKILL.md` into `~/.lannr/skills`, or into one
  agent's `agentDir/skills` when `--agent` is provided.

A skill is a directory with a `SKILL.md` whose YAML frontmatter has `name` and
`description` (this file also uses `version` so package upgrades can re-seed it).
Every agent sees the name/description/location of each global skill plus its own
agent-bound skills in its system prompt and reads the `SKILL.md` on demand.
Agents created with `--denyskills <name>` do not see matching global skills; the
deny list does not block agent-bound skills. Package-bundled skills (like this
one) are auto-installed on first use; do not rely on hand edits to them surviving
an upgrade — copy under a new name to customize.

### Memory
`<agent>` (id, name, or alias) is a required positional argument on every
subcommand — memory is per-agent, so you must say whose memory you mean.
- `lannr memory list <agent> [--user|--all]` (alias `ls`).
- `lannr memory add <agent> <text> [--user]`.
- `lannr memory replace <agent> <old> <new> [--user]`.
- `lannr memory remove <agent> <text> [--user]` (alias `rm`).
- `lannr memory show <agent> [--user]` / `lannr memory path <agent> [--user]`.
  (`MEMORY.md` = agent notes, `USER.md` = facts about the person.)

### Scheduling (recurring/one-off agent turns)
- `lannr schedule ls [-a agent] [--all] [--json]` (aliases `recurrent`, `recur`).
- `lannr schedule show <id>`.
- `lannr schedule add ...` — schedule an agent turn (mirrors `$scheduleAgentTurn`).
- `lannr schedule rm <id>` (alias `delete`), `disable <id>`, `enable <id>`,
  `run <id>` (run once now without changing the schedule).

### Reactive routines (cron/event/webhook triggers)
- `lannr reactive list [-a agent] [--json]` (alias `scheduler` / `ls`).
- `lannr reactive cron|once|event|webhook <name> ...` — create/replace a routine
  with a trigger. Common opts: `-a/--agent`, `--sink <json>` (default
  `{"type":"store"}`), `--failure-threshold <n>`, `--input <json>` (for `once`).
- `lannr reactive run <name> [--payload <json>]` — run immediately.
- `lannr reactive publish <event> [--payload] [-a agent]` — emit a local event and
  fire matching event routines.

### Saved routines (typed, replayable programs)
- `lannr routine list [-a agent] [--min-trust draft|provisional|trusted|pinned]`.
- `lannr routine show <id>` (alias `inspect`).
- `lannr routine run <routine> [-a agent]`.
- `lannr routine rollback <id> ...` — revert to an earlier version.

### MCP servers
- `lannr mcp list [--json]` (alias `ls`).
- `lannr mcp add <id> ...` — register a stdio MCP server: `--arg` (repeatable),
  `--env KEY=VALUE` (repeatable), `--cwd`.
- `lannr mcp rm <id>` (alias `remove`).
- `lannr mcp tools <id> [--json]` — list tools a server exposes.

### Plugins (custom tool modules)
- `lannr plugins list [--json]` (alias `ls`).
- `lannr plugins add <path> [--id <id>]` — register a JS module exporting tools.
- `lannr plugins rm <id>` (alias `remove`).

### Settings & import
- `lannr settings` — settings UI; `lannr settings list|get <key>|set <key> <value>`.
- `lannr import <source> [what] [opts]` — import providers/agents from another
  platform (e.g. hermes, openclaw): `--source-path`, `--overwrite`, `--dry-run`,
  `--include-secrets`, `--no-set-primary`.

### Hub / gateway
- `lannr hub start` (aliases `gateway`, `run`) — run the local agent hub server:
  `-p/--port`, `--host`, `-m/--model`, `--base-url`, `--api-key`.

## Acting on yourself — practical recipes

- **Change your own instructions/identity:** edit `AGENTS.md` / `IDENTITY.md` /
  `SOUL.md` in your workspace, or `lannr agents update <your-id> --instructions
  "..."`. Workspace files take effect on the next prompt build.
- **Remember something durable:** use `$memory` (preferred) or
  `lannr memory add <your-id> "..."`.
- **Find your own id / workspace:** it's in your system prompt's *Workspace
  context*; or `lannr agents ls --json`.
- **Add a capability:** `lannr mcp add ...` for an MCP server, `lannr plugins add
  ...` for a local tool module, `lannr tools setup` for web tools.
- **Schedule future work:** `$scheduleAgentTurn` in-program, or `lannr schedule
  add ...` from the shell.
- **Spin up a helper:** `$spawnAgent` for a focused subtask (pass full context),
  or `lannr agents add <name> <provider> ...` to create a persistent one.
- **Recover from a bad edit:** `lannr undo` or `$checkpointRestore`.

When unsure of exact flags, run the command with `--help` via `$bash` and read
the output before acting.
