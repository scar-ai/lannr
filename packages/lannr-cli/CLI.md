# Lannr CLI

The Lannr CLI (`lannr`) is the local runtime interface for the Lannr SDK. It manages providers, agents, sessions, routines, schedules, reactive routines, MCP servers, plugins, and skills from the terminal.

## Let the Agent Set Things Up For You

You don't have to run CLI commands manually. Lannr agents understand the full CLI — including how to install skills, connect MCP servers, add memory entries, configure providers, and schedule routines — and can execute those commands on your behalf during a normal conversation.

Just ask in chat:

```
"Add the filesystem MCP server pointing to /tmp"
"Install the code-review skill from ./skills/code-review"
"Remember that I prefer TypeScript over JavaScript"
"Schedule a daily standup summary every morning at 9 AM"
"Set my default model to claude-opus-4-8"
"Create a new agent called Research and bind it to *.md files"
"Save this workflow as a routine so I can rerun it later"
```

The agent will run the appropriate `lannr mcp add`, `lannr skills add`, `lannr memory add`, `lannr schedule add`, or `lannr agents` commands for you — including looking up what arguments are needed and confirming the result. No need to look up flags or syntax.

---

## Installation

```sh
pnpm add -g lannr-cli
# or from the repo root:
pnpm build
```

The binary is `lannr`.

Update the global CLI to the latest published npm version:

```sh
lannr update
```

## First-time Setup

```sh
lannr setup
```

Aliases: `lannr onboard`, `lannr configure`, `lannr config`

Interactive wizard that configures a provider and creates a default agent workspace. All options can be passed as flags for non-interactive or CI use:

```sh
lannr setup \
  --non-interactive \
  --auth-choice openai \
  --openai-api-key "$OPENAI_API_KEY" \
  --model gpt-4.1 \
  --agent-name "Dev"
```

Key flags:

| Flag | Description |
| --- | --- |
| `--auth-choice <choice>` | `openai`, `anthropic`, `opencode`, `custom-api-key`, or `skip` |
| `--flow <flow>` | Onboard flow: `quickstart`, `advanced`, or `manual` |
| `--mode <mode>` | Onboard mode: `local` |
| `--provider <id>` | Provider id for non-interactive setup |
| `--api-key <key>` | Generic inline provider API key |
| `--api-key-env <name>` | Generic provider API key env var |
| `--openai-api-key <key>` | OpenAI API key |
| `--anthropic-api-key <key>` | Anthropic API key |
| `--google-api-key <key>` | Google API key |
| `--openrouter-api-key <key>` | OpenRouter API key |
| `--opencode-api-key <key>` | OpenCode API key |
| `--base-url <url>` | Override provider base URL |
| `--model <model>` | Default model |
| `--endpoint <endpoint>` | SDK endpoint mode |
| `--custom-base-url <url>` | Custom provider base URL |
| `--custom-api-key <key>` | Custom provider inline API key |
| `--custom-model-id <id>` | Custom provider model id |
| `--custom-provider-id <id>` | Custom provider id |
| `--custom-compatibility <mode>` | `openai-compatible`, `anthropic`, or `google` |
| `--agent-name <name>` | Default agent name |
| `--agent-description <text>` | Default agent purpose |
| `--agent-instructions <text>` | Default agent operating instructions |
| `--workspace <dir>` | Agent workspace directory |
| `--alias <alias>` | Provider alias (repeatable) |
| `--accept-risk` | Acknowledge local agent file/tool access risk |
| `--non-interactive` | Skip all prompts |
| `--skip-tour` | Skip the animated feature tour |
| `--skip-chat` | Do not auto-launch chat after setup |

---

## Running Prompts

### `lannr run`

Run a one-shot prompt with a Lannr agent and stream the result to stdout.

```sh
lannr run "Summarize the last 10 commits"
lannr run "Read package.json and list dependencies" --agent dev
lannr run --session work "Continue working on the auth module"
```

| Flag | Description |
| --- | --- |
| `[prompt...]` | Prompt text (reads stdin if omitted) |
| `-a, --agent <agent>` | Agent id, name, or alias |
| `-p, --provider <provider>` | Provider override |
| `-m, --model <model>` | Model override |
| `--session <id>` | Save this run under a session id |

### `lannr resume`

Resume a previously saved session in the interactive TUI.

```sh
lannr resume my-session
lannr resume my-session --agent dev --message "Continue where we left off"
```

| Flag | Description |
| --- | --- |
| `<session>` | Session id to resume |
| `-a, --agent <agent>` | Agent id, name, or alias |
| `-p, --provider <provider>` | Provider override |
| `-m, --model <model>` | Model override |
| `--message <text>` | Send an initial message after opening |
| `--history-limit <n>` | Messages to keep in context (default: `200`) |
| `--no-tools` | Hide tool execution events |
| `--thinking` | Show raw program output |

### `lannr chat`

Open the interactive terminal UI (TUI).

Aliases: `lannr tui`, `lannr terminal`

```sh
lannr chat
lannr chat --agent dev --session work
```

| Flag | Description |
| --- | --- |
| `-a, --agent <agent>` | Agent id, name, or alias |
| `-p, --provider <provider>` | Provider override |
| `-m, --model <model>` | Model override |
| `--session <key>` | Session id to open |
| `--message <text>` | Send an initial message after opening |
| `--history-limit <n>` | Messages to keep in context (default: `200`) |
| `--no-tools` | Hide tool execution events |
| `--thinking` | Show raw program output |

#### In-chat slash commands

Type `/` to autocomplete. Available while chatting:

| Command | Description |
| --- | --- |
| `/help` | List commands |
| `/status` | Current agent / session / provider / model |
| `/context`, `/usage` | Token usage breakdown for the context window |
| `/agent` | Browse agents and resume their last session |
| `/model [name]` | Switch model (opens a picker with no argument) |
| `/provider [id]` | Set/show the provider override |
| `/sessions` | Browse and resume past sessions |
| `/new` | Start a fresh session |
| `/title <name>` | Name the current session |
| `/history` | Show recent messages |
| `/retry` | Re-run the last message |
| `/copy` | Copy the last reply to the system clipboard |
| `/save [path]` | Write the transcript to a markdown file |
| `/compact` | Summarize the conversation history now |
| `/theme [name]` | Switch color theme (`lannr`, `mono`, `dracula`, `nord`, `matrix`, `sunset`) |
| `/tools`, `/verbose` | Toggle tool output |
| `/thinking`, `/reasoning` | Toggle thinking output |
| `/undo` | Restore the workspace to the last checkpoint |
| `/fortune` | Draw a fortune |
| `/clear` | Clear the screen |
| `/exit`, `/quit` | Leave the TUI |

Other input conventions: prefix a line with `!` to run a shell command, drag-and-drop or paste an image path to attach it, press `esc` to stop a running turn, and press `Ctrl+C` twice to quit. The chosen `/theme` persists across sessions in `~/.lannr/settings.json`.

---

## Agents

Manage isolated agents. Each agent has its own workspace, instructions, provider, and memory.

### `lannr agents ls`

```sh
lannr agents ls
lannr agents ls --json
lannr agents ls --bindings
```

### `lannr agents add`

```sh
lannr agents add "Dev" openai --workspace ./workspace --model gpt-4.1
lannr agents add "Research" anthropic --non-interactive
```

| Flag | Description |
| --- | --- |
| `<name>` | Agent display name |
| `<provider>` | Provider id or alias (required) |
| `--description <text>` | Agent description |
| `--instructions <text>` | Operating instructions |
| `--workspace <path>` | Agent workspace directory |
| `--agent-dir <path>` | Agent state directory |
| `--alias <alias>` | Alias (repeatable) |
| `--bind <route>` | Routing binding (repeatable) |
| `--denyskills <skills>` | Comma-separated skill names to block |
| `--globalreach` | Allow access to files outside workspace |
| `--default` | Make this the default agent |
| `--non-interactive` | Skip prompts; defaults workspace to `~/.lannr/agents/<id>/workspace` |
| `--overwrite-workspace-files` | Rewrite generated workspace markdown files |
| `--json` | Output JSON summary |

### `lannr agents edit`

Open an interactive editor UI for an agent.

```sh
lannr agents edit dev
```

### `lannr agents update`

Update an agent without the interactive editor. Alias: `lannr agents set`.

```sh
lannr agents update dev --model gpt-4.1 --instructions "Focus on TypeScript"
lannr agents update dev --alias d --default
```

| Flag | Description |
| --- | --- |
| `--name <name>` | Display name |
| `--description <text>` | Description |
| `--instructions <text>` | Operating instructions |
| `--provider <id>` | Provider override |
| `--model <model>` | Model override |
| `--alias <alias>` | Replace aliases (repeatable) |
| `--bind <route>` | Replace routing bindings (repeatable) |
| `--denyskills <skills>` | Replace denied skills |
| `--globalreach` / `--no-globalreach` | Toggle file access outside workspace |
| `--default` | Make this the default agent |
| `--json` | Output JSON summary |

### `lannr agents rm`

```sh
lannr agents rm dev
```

Aliases: `lannr agents remove`, `lannr agents delete`

### Routing Bindings

```sh
lannr agents bindings              # list all bindings
lannr agents bind --agent dev --bind "*.ts"
lannr agents unbind --agent dev --bind "*.ts"
lannr agents unbind --agent dev --all
```

### Agent Identity

```sh
lannr agents set-identity --agent dev --name "Dev" --emoji "🤖" --theme dark
lannr agents set-identity --workspace ./workspace --from-identity
```

---

## Providers

Manage model provider registrations.

### `lannr provider ls`

```sh
lannr provider ls
lannr provider ls --json
lannr provider ls --available     # show OpenClaw provider presets
```

### `lannr provider primary`

```sh
lannr provider primary            # show current primary
lannr provider primary openai     # set primary provider
```

### `lannr provider new`

Create or update a provider registration. Alias: `lannr provider add`.

```sh
lannr provider new openai \
  --type openai-compatible \
  --base-url https://api.openai.com/v1 \
  --api-key-env OPENAI_API_KEY \
  --model gpt-4.1 \
  --endpoint chat-completions
```

| Flag | Description |
| --- | --- |
| `[id]` | Provider id |
| `--name <name>` | Display name |
| `--type <type>` | Provider type |
| `--base-url <url>` | OpenAI-compatible base URL |
| `--api-key <key>` | Inline API key |
| `--api-key-env <name>` | Environment variable that holds the API key |
| `--model <model>` | Default model |
| `--models <models>` | Additional models, comma-separated |
| `--endpoint <endpoint>` | `chat-completions`, `responses`, `codex-responses`, or `completions` |
| `--alias <alias>` | Alias (repeatable) |

### `lannr provider login`

Authenticate a provider. Currently only `openai-codex` is supported.

```sh
lannr provider login openai-codex
```

### `lannr provider rm`

```sh
lannr provider rm openai
```

### Managing Models

```sh
lannr provider models ls openai
lannr provider models add openai gpt-4o gpt-4o-mini
lannr provider models rm openai gpt-4o-mini
lannr provider models default openai gpt-4.1
```

---

## Memory

Manage the curated notes an agent carries across sessions. Stored in two files per agent: `MEMORY.md` (task/project notes) and `USER.md` (user profile notes).

The agent (id, name, or alias) is a required first positional argument on every subcommand.

```sh
lannr memory list dev                      # show dev's MEMORY.md entries
lannr memory list dev --user               # show USER.md entries
lannr memory list dev --all                # show both
lannr memory list dev --json
```

```sh
lannr memory add dev "Prefers concise answers"
lannr memory add dev "User works in TypeScript" --user
```

```sh
lannr memory replace dev "Prefers concise" "Prefers very concise, no fluff"
```

```sh
lannr memory remove dev "Prefers very concise"
```

```sh
lannr memory show dev           # print raw MEMORY.md
lannr memory show dev --user    # print raw USER.md
lannr memory path dev           # print on-disk path
```

---

## Routines

Manage saved, versioned programs the agent has stored in memory.

```sh
lannr routine list
lannr routine list --min-trust provisional   # draft|provisional|trusted|pinned
lannr routine list --json -a dev
```

```sh
lannr routine show <routine-id>
```

```sh
lannr routine rollback <routine-id> --to-version 2
```

```sh
lannr routine run <routine-id-or-name> --input '{"query":"state management"}'
```

All subcommands accept `-a, --agent <agent>`.

### How routines get created

You rarely create routines by hand. They appear in two ways:

- **The agent distills them automatically.** When the agent finishes a multi-step workflow that is general and likely to recur, it persists a generalized version on its own (via its `distillRoutine` tool) — no prompt required. Distilled routines are tagged `distilled` and start at trust level `draft`.
- **As a side effect of scheduling.** Scheduling a tool call writes a backing routine (see [Scheduled Actions](#scheduled-actions)).

### Trust levels

Routines graduate automatically as they run successfully:

| Level | Reached when | Behavior |
| --- | --- | --- |
| `draft` | Newly created | Listed for the agent's awareness; **not** auto-bound for direct `$name(input)` calls |
| `provisional` | ≥5 runs, ≥85% success | Auto-selectable; the agent can replay it inline |
| `trusted` | ≥50 runs, ≥93% success | Same, with higher selection priority |
| `pinned` | Set explicitly | Never auto-demoted |

Use `lannr routine run` to exercise a `draft` routine and help it graduate, or `lannr routine list --min-trust draft` to see everything the agent has distilled.

---

## Scheduled Actions

Schedule recurring or one-off agent prompts. The scheduler runs saved routines or direct agent turns on cron, interval, or one-time triggers.

Aliases: `lannr recurrent`, `lannr recur`

### List

```sh
lannr schedule ls
lannr schedule ls --agent dev
lannr schedule ls --all            # include disabled
lannr schedule ls --json
```

### Add

```sh
# Recurring: every 2 hours
lannr schedule add \
  --description "Hourly health check" \
  --prompt "Check service health and report any issues" \
  --every 2h \
  --agent dev

# One-shot offset
lannr schedule add \
  --description "Send reminder" \
  --prompt "Remind team about the release" \
  --in 30m

# ISO timestamp
lannr schedule add \
  --description "Weekly report" \
  --prompt "Generate the weekly NPM report" \
  --run-at "2025-06-02T09:00:00Z"

# Cron expression
lannr schedule add \
  --description "Monday standup" \
  --prompt "Generate standup notes from recent commits" \
  --cron "0 9 * * 1"
```

| Flag | Description |
| --- | --- |
| `-d, --description <text>` | Short description shown in `schedule ls` (required) |
| `-m, --prompt <text>` | Prompt the agent receives when the action fires (required) |
| `--every <duration>` | Recurring interval: `10m`, `1h30m`, `2h`, etc. |
| `--in <duration>` | One-shot offset from now |
| `--run-at <iso>` | One-shot ISO timestamp |
| `--cron <expr>` | Five-field cron expression |
| `--name <id>` | Explicit id; derived from description by default |
| `--failure-threshold <n>` | Disable after N consecutive failures (default: `5`) |
| `-a, --agent <agent>` | Agent id, name, or alias |

### Show / Remove / Enable / Disable / Run now

```sh
lannr schedule show <id>
lannr schedule rm <id>
lannr schedule disable <id>
lannr schedule enable <id>
lannr schedule run <id>             # run once immediately without changing schedule
```

---

## Reactive Routines

Lower-level control over the reactive routine store that backs scheduled actions. Where `schedule` deals in agent turns, `reactive` binds saved routines to cron, one-time, event, and webhook triggers.

Aliases: `lannr scheduler`

All subcommands accept `-a, --agent <agent>`.

### List

```sh
lannr reactive list
lannr reactive ls --json
```

### Create triggers

```sh
# Cron-triggered routine
lannr reactive cron daily-report \
  --cron "0 9 * * *" \
  --routine npm-report \
  --input '{"window":"24h"}'

# One-time run
lannr reactive once release-note \
  --run-at "2025-06-02T09:00:00Z" \
  --routine changelog \
  --input '{}'

# Event-triggered routine
lannr reactive event on-deploy \
  --event deploy.succeeded \
  --routine notify \
  --input-mapper "(event) => ({ sha: event.sha })"

# Webhook-triggered routine
lannr reactive webhook gh-push \
  --routine build \
  --input-mapper "(event) => ({ ref: event.ref })" \
  --secret "$WEBHOOK_SECRET"
```

| Flag | Description |
| --- | --- |
| `--cron <expr>` | Five-field cron expression (`cron`) |
| `--run-at <time>` | Future timestamp parseable by `Date` (`once`) |
| `--event <event>` | Event name (`event`) |
| `--routine <routine>` | Saved routine id or name (required) |
| `--input <json>` | JSON input passed to the routine |
| `--input-mapper <source>` | Pure mapper source, e.g. `(event) => ({ value: event.value })` (`event`, `webhook`) |
| `--secret <secret>` | Webhook secret (`webhook`) |
| `--sink <json>` | Sink JSON; defaults to `{"type":"store"}` |
| `--failure-threshold <n>` | Disable after N consecutive failures |

### Run, publish, enable/disable, remove

```sh
lannr reactive run <name> --payload '{"value":1}'      # run immediately
lannr reactive publish <event> --payload '{"value":1}' # publish a local event
lannr reactive handle-webhook <name> --payload '{}' --secret "$SECRET"
lannr reactive enable <name>
lannr reactive disable <name>
lannr reactive rm <name>
lannr reactive start --poll-ms 10000                   # run the in-process cron scheduler
```

---

## Sessions

Inspect saved chat session history.

```sh
lannr sessions list
lannr sessions list --agent dev
lannr sessions list --json
```

---

## MCP Servers

Manage MCP (Model Context Protocol) servers connected over stdio.

```sh
lannr mcp ls
lannr mcp ls --json
```

```sh
lannr mcp add filesystem \
  --command npx \
  --arg @modelcontextprotocol/server-filesystem \
  --arg /tmp \
  --cwd /tmp
```

| Flag | Description |
| --- | --- |
| `<id>` | Server id |
| `--command <cmd>` | Command to launch the MCP server (required) |
| `--arg <arg>` | Argument (repeatable) |
| `--env <KEY=VALUE>` | Environment variable (repeatable) |
| `--cwd <dir>` | Working directory for the server process |

```sh
lannr mcp rm filesystem
lannr mcp tools filesystem             # list tools exposed by a server
lannr mcp tools filesystem --json
```

---

## Plugins

Register local JavaScript modules that export additional agent tools.

```sh
lannr plugins list
lannr plugins ls --json
```

```sh
lannr plugins add ./my-tools.js                # register a plugin module
lannr plugins add ./my-tools.js --id my-tools  # explicit id (defaults to file basename)
lannr plugins rm my-tools
```

Listed plugins are sourced either from the registry (`add`) or auto-discovered from the plugins home directory.

---

## Skills

Skills are reusable prompt/instruction sets. By default they are global and
shared across agents; `--agent <id>` installs one only for that agent.

```sh
lannr skills list
lannr skills list --json
```

```sh
lannr skills add ./my-skill-dir        # dir must contain a SKILL.md
lannr skills add ./my-skill-dir --force
lannr skills add ./my-skill-dir --agent my-agent
```

Agent `--denyskills` settings only hide matching global skills. Agent-bound
skills are always available to their owning agent.

---

## Settings

View and change Lannr runtime settings.

```sh
lannr settings                         # open interactive settings TUI
lannr settings list
lannr settings list --json
lannr settings get <key>
lannr settings set <key> <value>
```

---

## Status and Health

```sh
lannr status                  # show configured providers and agents
lannr status --json
```

```sh
lannr doctor                  # run setup health checks
```

`lannr doctor` exits with code `1` if any issues are found (missing provider, missing env var, agent pointing to unregistered provider, etc.).

---

## Undo

Restore the agent workspace to the state before the last agent turn using file-level checkpoints.

```sh
lannr undo                              # restore to the last checkpoint
lannr undo --list                       # list available checkpoints
lannr undo --turn <checkpoint-id>       # restore a specific checkpoint
lannr undo -a dev
lannr undo --json
```

---

## Hub Server

Run the Lannr gateway as a local HTTP server (OpenAI-compatible API). Aliased as `lannr gateway`.

### `lannr hub start`

Starts the server in the background (survives terminal close). Alias: `lannr hub run`.

```sh
lannr hub start
lannr hub start --port 8080 --model gpt-4.1 --api-key "$OPENAI_API_KEY"
lannr hub start --foreground          # run in the foreground and stream logs
```

| Flag | Description |
| --- | --- |
| `-p, --port <port>` | Port to listen on |
| `--host <host>` | Host to bind |
| `-m, --model <model>` | Default model |
| `--base-url <url>` | OpenAI-compatible model API base URL |
| `--api-key <key>` | API key; falls back to `LANNR_API_KEY` or `OPENAI_API_KEY` |
| `-f, --foreground` | Run in the foreground and stream logs to this terminal |

### `lannr hub stop` / `lannr hub status`

```sh
lannr hub stop                        # stop the background server
lannr hub status                      # show whether it is running (with pid + log path)
```

---

## Import

Import providers and agents from another agent platform.

Supported sources: `hermes`, `openclaw`

```sh
lannr import hermes                     # import everything
lannr import hermes providers           # providers only
lannr import hermes agents             # agents only
lannr import openclaw --dry-run
lannr import hermes --overwrite --include-secrets --json
```

| Flag | Description |
| --- | --- |
| `<source>` | `hermes` or `openclaw` |
| `[what]` | `all`, `providers`, or `agents` (default: `all`) |
| `--source-path <path>` | Override config root (default: `~/.hermes` or `~/.openclaw`) |
| `--overwrite` | Overwrite existing providers/agents |
| `--dry-run` | Show what would be imported without writing |
| `--include-secrets` | Copy inline API keys when found (hermes only) |
| `--no-set-primary` | Do not change the primary provider |
| `--json` | Output JSON summary |

---

## Optional Tools Setup

Configure optional `webFetch` and `webSearch` tool support for agents.

```sh
lannr tools setup
lannr tools setup --provider exa --api-key "$EXA_API_KEY"
lannr tools setup --web-search-provider tavily --api-key-env TAVILY_API_KEY
lannr tools setup --non-interactive --provider skip
```

Supported web search providers: `exa`, `tavily`, `skip`

---

## Uninstall

Completely and cleanly remove Lannr from the machine. This stops the background
hub daemon and deletes the entire data directory (`~/.lannr`, or `$LANNR_HOME`):
agents, sessions, skills, providers, scheduler state, and hub logs. It can also
remove the global CLI package.

```sh
lannr uninstall                       # stop hub + delete ~/.lannr (asks to confirm)
lannr uninstall --dry-run             # show what would be removed, delete nothing
lannr uninstall --yes                 # skip the confirmation prompt
lannr uninstall --keep-data           # remove only the binary, keep ~/.lannr
lannr uninstall --remove-binary       # also uninstall the global CLI
lannr uninstall --yes --remove-binary --json
```

| Flag | Description |
| --- | --- |
| `-y, --yes` | Skip the confirmation prompt |
| `--keep-data` | Keep `~/.lannr` (use with `--remove-binary` to drop only the CLI) |
| `--remove-binary` | Also uninstall the global `lannr-cli` bin |
| `--dry-run` | Show what would be removed without deleting anything |
| `--json` | Print the result as JSON |

The confirmation prompt requires typing `uninstall` (or `yes`/`y`); any other
answer aborts without touching anything.

`--remove-binary` detects how the CLI was installed by looking at where `lannr`
resolves on `PATH`, and runs the matching uninstall — `npm uninstall -g`,
`pnpm remove -g`, `yarn global remove`, or `bun remove -g`. This handles both a
published npm package and a `pnpm`/`yarn` global **link** to a source checkout.
After running it the command re-checks `PATH` and reports whether the bin is
actually gone (package managers exit `0` even when they removed nothing), and
prints the exact command to finish by hand if anything still resolves.

---

## Global Flags

Most commands accept these flags where applicable:

| Flag | Description |
| --- | --- |
| `-a, --agent <agent>` | Agent id, name, or alias |
| `--json` | Print output as JSON instead of a table |
| `--non-interactive` | Disable interactive prompts |
