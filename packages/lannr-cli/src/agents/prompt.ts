import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { arch, hostname, platform, release } from 'node:os'
import { agentMemoryDir, createAgentMemoryStore } from './memory.js'
import { buildSkillsPrompt } from './skills.js'
import { loadAgentMemorySnapshot, renderMemoryForPrompt } from './tools/memory.js'
import { toWorkspaceRelative, truncateText } from './tools/helpers.js'

export const instructionFiles = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'BOOTSTRAP.md']
export const startupMemoryFiles = ['MEMORY.md', 'USER.md']

// Sentinel used by provider adapters to split the system prompt into a stable
// (cacheable) prefix and a dynamic suffix. Anthropic adapters attach
// `cache_control` to the prefix; OpenAI prefix-matching benefits automatically.
export const SYSTEM_PROMPT_CACHE_BOUNDARY = '\n<!-- LANNR_CACHE_BOUNDARY -->\n'

export function splitSystemPromptCacheBoundary(text) {
  const idx = text.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY)
  if (idx === -1) return undefined
  return {
    stablePrefix: text.slice(0, idx).trimEnd(),
    dynamicSuffix: text.slice(idx + SYSTEM_PROMPT_CACHE_BOUNDARY.length).trimStart(),
  }
}

export function stripSystemPromptCacheBoundary(text) {
  return text.replaceAll(SYSTEM_PROMPT_CACHE_BOUNDARY, '\n\n')
}

export async function buildAgentSystemPrompt(agent, workspace) {
  const globalReach = Boolean(agent.globalReach)

  const parts = [
    `You are ${agent.identity?.name ?? agent.name}, a Lannr SDK agent.`,
    agent.description ? `Purpose: ${agent.description}` : '',
    agent.instructions ? `Instructions:\n${agent.instructions}` : '',
    globalReach
      ? 'Use the provided workspace tools for local file context. This agent has global reach enabled, so absolute paths outside the workspace are allowed.'
      : 'Use the provided workspace tools for local file context. Stay inside the workspace.',
    [
      'Lannr execution model:',
      '- Write TypeScript programs that call `$toolName` bindings. One program can call many tools.',
      '- Prefer `Promise.all` for independent calls, loops and maps for collections, and exact JS arithmetic over asking the model to estimate.',
      '- Use `$bash` (with `ls`, `find`, `grep`/`rg`, `cat`, etc.) to explore the workspace and locate code, config, or text patterns before reading full files.',
    ].join('\n'),
    [
      'Routines (reusable workflows):',
      '- The "Saved routines" section of your turn context lists routines already distilled, with their trust level. Routines at trust "provisional" or higher are bound as `$<name>(input)` — call one to replay it instead of redoing the work by hand.',
      '- When you finish a multi-step workflow that is general and likely to recur, persist it on your own with `$distillRoutine({ name, description, program, tags })` — do not wait to be asked. Generalize the program: read run-specific values (paths, queries) from `input` rather than hard-coding them.',
      '- New routines start at trust "draft" and are not bound for direct calls yet; they graduate to "provisional" automatically after they have run successfully enough. Use the built-in `$saveRoutine({ name, description })` instead when you want to capture the exact program you just ran verbatim, without generalizing it.',
      '- Refine an existing routine with `$patchRoutine` rather than distilling a near-duplicate. Do not distill one-off, trivial, or secret-bearing work.',
    ].join('\n'),
    [
      'Operating posture:',
      '- Gather local context with `$bash` (e.g. `ls`, `find`, `grep`/`rg`) and `$readFile` before asking questions when the answer is discoverable.',
      '- Preserve user intent across turns; treat short confirmations as approval for the concrete next action you offered.',
      '- For larger work: inspect → change → verify → report concisely what changed and what could not be verified.',
      '- Use `$bash` for all shell-style file ops (listing, moving, searching, inspecting binaries/PDFs). Reserve `$readFile`/`$writeFile`/`$editFile`/`$applyPatch` for text file I/O.',
      '- Use spawned agents only for focused specialist work; pass full context because they do not inherit this conversation.',
      '- Use shared skills when a task matches them; read the listed SKILL.md before following the skill workflow.',
      '- Prefer `$editFile` over `$writeFile` when modifying existing files; use `$writeFile` only for new files. Use `$applyPatch` when you already have a unified diff.',
    ].join('\n'),
    [
      'Memory (`$memory`):',
      "- target='user' is for facts about the person (name, role, preferences, recurring instructions, do-not rules).",
      "- target='memory' is for your own notes (project conventions, environment quirks, decisions, lessons learned).",
      '- Save the moment you learn something durable; do not wait until end-of-turn. Read at the start of a turn when prior context might apply.',
      '- Skip ephemeral task state, secrets, and anything trivially re-derivable from the code.',
    ].join('\n'),
    [
      'Scheduling (`$scheduleAgentTurn`, `$listScheduledActions`, `$cancelScheduledAction`):',
      '- When the user says "later", "at <time>", "every <duration>", or "remind me to X", schedule it instead of trying to remember.',
      '- Provide a short description, the natural-language prompt to run at fire time, and exactly one trigger (every / in / runAt / cron).',
      '- Use `$listScheduledActions` before adding when the user might be duplicating an existing schedule.',
      '- In scheduled-action listings, status=due means queued/overdue and not yet completed; only treat lastRunStatus=success or status=completed as completed.',
    ].join('\n'),
    'Operational rule: when a user refers to a file from the prior turn with "it", "that", "open it", "read it", "inspect it", or similar, act on the previously identified file. Do not re-list files unless the file path is unknown.',
    'Operational rule: when your previous answer offered a concrete next action and the user replies affirmatively, perform that action immediately.',
    'Operational rule: "open" a file means read its contents with `$readFile` (or `$bash cat` for non-UTF-8/binary), then report what you found. Do not answer by merely saying the file exists.',
    'Operational rule: do not end with "I can do X next" when X is the action the user just requested; do X now.',
    'Output hygiene: never restate, recap, paraphrase, or quote your <program> code in prose — not as markdown code fences, not as inline code, not in any form. The user does not see <program> blocks; mentioning `$bash`, `$readFile`, or any `$tool(...)` call in user-facing output is leak, not explanation. After a tool runs, write only the human-readable answer (or another <program> block if more work is needed).',
  ].filter(Boolean)

  for (const file of instructionFiles) {
    try {
      const content = await readFile(join(workspace, file), 'utf8')
      if (content.trim()) parts.push(`\n--- ${file} ---\n${content.trim()}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  const skillsPrompt = await buildSkillsPrompt(agent)
  if (skillsPrompt) parts.push(skillsPrompt)

  // Workspace/agent identity is stable across turns — safe inside the cache prefix.
  parts.push([
    'Workspace context:',
    `- Agent id: ${agent.id}`,
    `- Workspace root: ${workspace}`,
    `- Agent state directory: ${agent.agentDir}`,
    `- Provider: ${agent.provider}`,
    `- Host: ${hostname()} (${platform()} ${release()}, ${arch()})`,
  ].join('\n'))

  return parts.join('\n\n')
}

// Per-turn context — wall-clock time, memory snapshots, anything that changes
// between requests. Kept OUT of the system prompt and injected as a trailing
// message by the gateway so the system prefix + prior conversation stay
// byte-identical across turns (OpenAI / Anthropic prefix caches hit).
export async function buildPerTurnContext(agent, workspace) {
  const sections = []

  const memoryContext = await buildStartupMemoryContext(agent, workspace)
  if (memoryContext) sections.push(memoryContext)

  try {
    const snapshot = await loadAgentMemorySnapshot(agent)
    const curated = renderMemoryForPrompt(snapshot)
    if (curated) sections.push(curated)
  } catch {
    // curated memory is best-effort
  }

  const routines = await buildRoutineContext(agent)
  if (routines) sections.push(routines)

  sections.push(`Current local time: ${new Date().toString()}`)

  return sections.join('\n\n')
}

// Compact catalog of saved routines so the agent can reuse `$<name>(input)`
// or refine an existing routine instead of redoing the work or distilling a
// near-duplicate. Best-effort: never block a turn on routine listing.
const MAX_ROUTINE_SUMMARIES = 30

export async function buildRoutineContext(agent) {
  try {
    const store = createAgentMemoryStore(agent)
    const routines = await store.list({ minTrust: 'draft' })
    if (!routines.length) return ''
    const lines = routines.slice(0, MAX_ROUTINE_SUMMARIES).map((routine) => {
      const trust = routine.trust?.level ?? 'draft'
      const runs = routine.trust?.runs ?? 0
      const desc = routine.description ? ` — ${truncateText(routine.description, 160)}` : ''
      return `- $${routine.name} (${trust}, ${runs} runs)${desc}`
    })
    const overflow = routines.length > MAX_ROUTINE_SUMMARIES
      ? `\n…and ${routines.length - MAX_ROUTINE_SUMMARIES} more.`
      : ''
    return [
      'Saved routines:',
      'Reusable workflows you have distilled. Routines at trust provisional or higher are callable as `$<name>(input)` — replay one instead of redoing the work. Drafts are listed so you can refine them (`$patchRoutine`) or avoid distilling a near-duplicate; they graduate to provisional after running successfully enough.',
      ...lines,
    ].join('\n') + overflow
  } catch {
    return ''
  }
}

export async function buildStartupMemoryContext(agent, workspace) {
  const candidates = [
    ...startupMemoryFiles.map((file) => join(workspace, file)),
    join(agentMemoryDir(agent), 'MEMORY.md'),
    join(agentMemoryDir(agent), `${new Date().toISOString().slice(0, 10)}.md`),
  ]
  const sections = []
  for (const filePath of [...new Set(candidates)]) {
    try {
      const content = (await readFile(filePath, 'utf8')).trim()
      if (content) {
        sections.push(`--- ${toWorkspaceRelative(workspace, filePath)} ---\n${truncateText(content, 12_000)}`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  if (!sections.length) return ''
  return [
    'Startup memory context:',
    'Use this as continuity. Do not repeat it unless relevant.',
    ...sections,
  ].join('\n\n')
}
