import { readFile } from 'node:fs/promises'
import { getCliVersion } from '../version.js'
import { createInterface } from 'node:readline/promises'
import { join, resolve } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { LannrScheduler, InProcessEventBus } from 'lannr-extras/scheduler'
import React from 'react'
import { render } from 'ink'
import { loadConfig } from '../config.js'
import { listAgents, updateAgent, upsertAgent } from '../agents/registry.js'
import { createAgentMemoryStore, createAgentRuntime } from '../agents/runtime.js'
import { listSkills, parseSkillList } from '../agents/skills.js'
import { configureProviderOnly } from '../onboard.js'
import { getOpenClawProviderPreset, listOpenClawProviderCatalog } from '../providers/openclaw-catalog.js'
import { listProviders, providerRegistryPath, setPrimaryProvider, upsertProvider } from '../providers/registry.js'
import { loginOpenAICodex, openAICodexAuthPath } from '../providers/openai-codex-auth.js'
import { promptCodexAuthMode, runCodexLoginUi } from '../ui/CodexLogin.js'
import { createAgentReactiveRoutineStore } from '../scheduler/store.js'
import { Form } from '../ui/Form.js'
import { MultiSelect } from '../ui/MultiSelect.js'
import { color } from './help.js'

export async function prompt(question) {
  const rl = createInterface({ input, output })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

export async function readStdinOrPrompt(question) {
  if (!input.isTTY) {
    const chunks = []
    for await (const chunk of input) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (text) return text
  }
  return prompt(question)
}

export function collect(value, previous) {
  return [...previous, value]
}

// Renders an array of plain objects as an aligned ASCII table that fits the
// terminal width. Wide cells are truncated with an ellipsis instead of letting
// the row wrap and shatter the box-drawing (the failure mode of console.table).
export function printTable(rows, options: Record<string, any> = {}) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) {
    if (options.empty) console.log(options.empty)
    return
  }

  const columns = options.columns ?? [...new Set(list.flatMap((row) => Object.keys(row ?? {})))]
  if (!columns.length) return

  const cell = (value) => {
    if (value === null || value === undefined) return ''
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value).replace(/\s+/g, ' ').trim()
  }

  const data = list.map((row) => columns.map((key) => cell(row?.[key])))
  const MIN = 4
  const widths = columns.map((key, i) => Math.max(key.length, ...data.map((r) => r[i].length)))

  // Shrink to fit the terminal: repeatedly trim the widest column.
  const term = Number(output.columns) > 0 ? Number(output.columns) : 120
  const frame = (n) => 1 + n.reduce((sum, w) => sum + w + 3, 0)
  while (frame(widths) > term) {
    let widest = 0
    for (let i = 1; i < widths.length; i++) if (widths[i] > widths[widest]) widest = i
    if (widths[widest] <= MIN) break
    widths[widest] -= 1
  }

  const clip = (text, width) => (text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`)
  const pad = (text, width) => clip(text, width).padEnd(width)

  const border = (left, mid, right) =>
    color.dim(left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right)
  const rowLine = (cells, styler?: (value: string) => string) =>
    color.dim('│') + cells.map((text, i) => ` ${styler ? styler(pad(text, widths[i])) : pad(text, widths[i])} `).join(color.dim('│')) + color.dim('│')

  console.log(border('┌', '┬', '┐'))
  console.log(rowLine(columns, color.bold))
  console.log(border('├', '┼', '┤'))
  for (const r of data) console.log(rowLine(r))
  console.log(border('└', '┴', '┘'))
}

export async function resolveMemoryCommandRuntime(agentId) {
  const config = await loadConfig()
  const agent = resolveConfigAgent(config, agentId)
  return {
    agent,
    store: createAgentMemoryStore(agent),
  }
}

export async function resolveSchedulerCommandRuntime(agentId, options: Record<string, any> = {}) {
  const runtime = await createAgentRuntime({ agentId })
  const store = createAgentReactiveRoutineStore(runtime.agent)
  const bus = new InProcessEventBus()
  const scheduler = new LannrScheduler(runtime.lannr, store, bus, options.pollMs ?? 10_000)
  return {
    agent: runtime.agent,
    runtime,
    store,
    bus,
    scheduler,
  }
}

export function resolveConfigAgent(config, agentId) {
  const key = agentId ?? config.defaultAgentId ?? 'default'
  const agent = config.agents[key] ?? Object.values(config.agents).find((entry) => {
    return entry.id === key || entry.name?.toLowerCase() === String(key).toLowerCase() || entry.aliases?.includes(key)
  })
  if (!agent) throw new Error(`Agent not found: ${key}`)
  return agent
}

export async function resolveRoutineId(memory, value) {
  const summaries = await memory.list({ minTrust: 'draft' })
  const summary = summaries.find((entry) => entry.id === value || entry.name === value)
  if (!summary) throw new Error(`Routine not found: ${value}`)
  return summary.id
}

export function parseSinkOption(value) {
  if (!value) return { type: 'store' }
  const sink = parseJsonOption(value, '--sink')
  if (!sink || typeof sink !== 'object') throw new Error('--sink must be a JSON object')
  if (!['store', 'webhook', 'slack', 'email'].includes(sink.type)) throw new Error(`Unsupported sink type: ${sink.type}`)
  return sink
}

export function parseFutureDate(value, name) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid date or timestamp`)
  if (date.getTime() <= Date.now()) throw new Error(`${name} must be in the future`)
  return date
}

export function formatTrigger(trigger) {
  if (!trigger) return ''
  if (trigger.type === 'cron') return `cron:${trigger.cron}`
  if (trigger.type === 'event') return `event:${trigger.event}`
  if (trigger.type === 'once') return `once:${trigger.runAt}`
  if (trigger.type === 'webhook') return 'webhook'
  if (trigger.type === 'interval') return `every:${formatIntervalMs(trigger.intervalMs)}`
  return trigger.type
}

function formatIntervalMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '?'
  const units: Array<[string, number]> = [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]]
  let remaining = n
  const parts = []
  for (const [label, size] of units) {
    const whole = Math.floor(remaining / size)
    if (whole > 0) { parts.push(`${whole}${label}`); remaining -= whole * size }
  }
  return parts.length ? parts.join('') : `${ms}ms`
}

export function validateTrustLevel(level) {
  if (!['draft', 'provisional', 'trusted', 'pinned'].includes(level)) {
    throw new Error(`Invalid trust level: ${level}`)
  }
}

export function parseJsonOption(value, name) {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function uniqueById<T extends { id?: string }>(entries: T[]): T[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()]
}

export function normalizeCliId(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

export function resolveAgentFromList(agents, id) {
  const normalized = normalizeCliId(id)
  return agents.find((agent) => {
    return agent.id === normalized ||
      normalizeCliId(agent.name) === normalized ||
      (agent.aliases ?? []).some((alias) => normalizeCliId(alias) === normalized)
  })
}

export function printBanner() {
  if (!output.isTTY) return
  console.log('')
  console.log(`  ${color.bold(color.cyan('⚒  lannr'))}  ${color.dim(`v${getCliVersion()}`)}`)
  console.log(`  ${color.dim('Local agent runtime powered by the Lannr SDK.')}`)
  console.log('')
}

export async function readIdentityFile(path) {
  const content = await readFile(path, 'utf8')
  const fields = {}
  const patterns = {
    name: /(?:^|\n)\s*[-*]?\s*(?:\*\*)?Name(?:\*\*)?\s*:\s*(.+)/i,
    theme: /(?:^|\n)\s*[-*]?\s*(?:\*\*)?(?:Theme|Creature|Vibe)(?:\*\*)?\s*:\s*(.+)/i,
    emoji: /(?:^|\n)\s*[-*]?\s*(?:\*\*)?Emoji(?:\*\*)?\s*:\s*(.+)/i,
    avatar: /(?:^|\n)\s*[-*]?\s*(?:\*\*)?Avatar(?:\*\*)?\s*:\s*(.+)/i,
  }
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = content.match(pattern)
    const value = match?.[1]?.replace(/[_*`]/g, '').trim()
    if (value && !value.startsWith('(')) fields[key] = value
  }
  return fields
}

export async function buildHealthReport() {
  const config = await loadConfig()
  const providers = uniqueById(Object.values(config.providers))
  const agents = uniqueById(Object.values(config.agents))
  const checks = [
    { name: 'providers', ok: providers.length > 0, detail: providers.length ? `${providers.length} configured` : 'none configured' },
    { name: 'agents', ok: agents.length > 0, detail: agents.length ? `${agents.length} configured` : 'none configured' },
    { name: 'default agent', ok: Boolean(config.agents[config.defaultAgentId]), detail: config.defaultAgentId },
    { name: 'primary provider', ok: Boolean(config.providers[config.primaryProviderId] || config.providers.default), detail: config.primaryProviderId },
  ]
  for (const provider of providers) {
    checks.push({
      name: `provider:${provider.id}:model`,
      ok: Boolean(provider.defaultModel),
      detail: provider.defaultModel || 'missing default model',
    })
    if (provider.apiKeyEnv) {
      checks.push({
        name: `provider:${provider.id}:auth`,
        ok: Boolean(process.env[provider.apiKeyEnv] || provider.apiKey),
        detail: process.env[provider.apiKeyEnv] || provider.apiKey ? 'configured' : `missing ${provider.apiKeyEnv}`,
      })
    }
  }
  return { ok: checks.every((check) => check.ok), checks }
}

export async function printHome() {
  printBanner()
  const config = await loadConfig()
  const providers = uniqueById(Object.values(config.providers))
  const agents = uniqueById(Object.values(config.agents))

  console.log(`  ${color.bold('Default agent')}     ${color.cyan(config.defaultAgentId ?? '—')}`)
  console.log(`  ${color.bold('Primary provider')}  ${color.cyan(config.primaryProviderId ?? '—')}`)
  console.log(`  ${color.bold('Configured')}        ${color.green(`${agents.length}`)} ${color.dim('agent(s),')} ${color.green(`${providers.length}`)} ${color.dim('provider(s)')}`)
  console.log('')
  console.log(`  ${color.bold('Common commands')}`)
  console.log(`    ${color.cyan('lannr setup')}              ${color.dim('first-time configuration')}`)
  console.log(`    ${color.cyan('lannr chat')}               ${color.dim('open the terminal UI')}`)
  console.log(`    ${color.cyan('lannr run')} ${color.yellow('"<prompt>"')}     ${color.dim('one-shot prompt')}`)
  console.log(`    ${color.cyan('lannr agents list')}        ${color.dim('show all agents')}`)
  console.log(`    ${color.cyan('lannr provider list')}      ${color.dim('show all providers')}`)
  console.log(`    ${color.cyan('lannr hub start')}          ${color.dim('start the local hub server')}`)
  console.log('')
  console.log(`  ${color.dim('Run')} ${color.cyan('lannr --help')} ${color.dim('to see all commands.')}`)
  console.log('')
}

export async function listProviderCommand(opts) {
  const providers = opts.available ? listOpenClawProviderCatalog() : await listProviders()
  if (opts.json) {
    console.log(JSON.stringify(providers, null, 2))
    return
  }
  if (providers.length === 0) {
    console.log(`No providers registered. Registry: ${providerRegistryPath()}`)
    return
  }
  const rows = providers.map((entry) => ({
    id: entry.id,
    primary: entry.primary ? 'yes' : '',
    type: entry.type,
    model: entry.defaultModel ?? '',
    models: entry.models?.join(',') ?? '',
    baseURL: entry.baseURL ?? '',
    auth: entry.id === 'openai-codex' ? `oauth:${openAICodexAuthPath()}` : entry.apiKeyEnv ? `env:${entry.apiKeyEnv}` : entry.apiKey ? 'inline' : '',
    support: entry.unsupportedReason ? entry.unsupportedReason : 'local',
    aliases: entry.aliases.join(','),
  }))
  printTable(rows)
}

export async function promptForProvider({ id, opts }) {
  const providerId = id?.trim()

  const hasAllFlags = Boolean(
    opts.type || opts.model || opts.baseUrl || opts.apiKey || opts.apiKeyEnv,
  )
  if (hasAllFlags || opts.nonInteractive) {
    const preset = providerId ? getOpenClawProviderPreset(providerId) : undefined
    const providerOpts = {
      ...opts,
      provider: providerId,
      authChoice: providerId ? (preset ? providerId : 'custom-api-key') : opts.authChoice,
      customProviderId: providerId && !preset ? providerId : opts.customProviderId,
    }
    return configureProviderOnly(providerOpts)
  }

  if (!input.isTTY) {
    const preset = providerId ? getOpenClawProviderPreset(providerId) : undefined
    const providerOpts = {
      ...opts,
      provider: providerId,
      authChoice: providerId ? (preset ? providerId : 'custom-api-key') : opts.authChoice,
      customProviderId: providerId && !preset ? providerId : opts.customProviderId,
    }
    return configureProviderOnly(providerOpts)
  }

  const catalog = listOpenClawProviderCatalog().filter((p) => !p.unsupportedReason)
  const catalogItems = catalog.map((p) => ({ value: p.id, label: p.name ?? p.id, hint: p.type }))
  catalogItems.push({ value: 'custom', label: 'Custom provider', hint: 'enter details manually' })

  let selectedPresetId = providerId
  if (!selectedPresetId) {
    selectedPresetId = await new Promise((resolveSelect) => {
      const { unmount } = render(
        React.createElement(MultiSelect, {
          label: 'Select a provider',
          items: catalogItems,
          onSelect: (item) => { unmount(); resolveSelect(item.value) },
          onCancel: () => { unmount(); resolveSelect(null) },
        }),
      )
    })
    if (!selectedPresetId) return undefined
  }

  const preset = getOpenClawProviderPreset(selectedPresetId)
  const isCustom = !preset || selectedPresetId === 'custom'
  const isOpenAICodex = preset?.id === 'openai-codex'

  const codexAuthMode = isOpenAICodex
    ? (input.isTTY ? await promptCodexAuthMode() : 'device')
    : undefined

  const fields = isOpenAICodex ? [
    { name: 'id',    label: 'Provider ID',   placeholder: selectedPresetId, default: selectedPresetId, required: true },
    { name: 'model', label: 'Default model', placeholder: preset?.defaultModel ?? 'gpt-5.4-pro', default: preset?.defaultModel ?? '', required: true },
    { name: 'models', label: 'Other models', placeholder: 'gpt-5.4-mini,gpt-5.4', default: opts.models ?? '', hint: 'Comma-separated, optional' },
  ] : [
    { name: 'id',         label: 'Provider ID',     placeholder: isCustom ? 'my-provider' : selectedPresetId, default: isCustom ? '' : selectedPresetId, required: true },
    { name: 'type',       label: 'API type',         placeholder: 'openai-compatible', default: preset?.type ?? 'openai-compatible' },
    { name: 'baseUrl',    label: 'Base URL',         placeholder: preset?.baseURL ?? 'https://api.openai.com/v1', default: preset?.baseURL ?? '', hint: 'Leave empty for default' },
    { name: 'model',      label: 'Default model',    placeholder: preset?.defaultModel ?? 'gpt-4.1', default: preset?.defaultModel ?? '', required: true },
    { name: 'models',     label: 'Other models',     placeholder: 'gpt-4.1-mini,gpt-4.1', default: opts.models ?? '', hint: 'Comma-separated, optional' },
    { name: 'apiKeyEnv',  label: 'API key env var',  placeholder: preset?.apiKeyEnv ?? 'MY_API_KEY', default: preset?.apiKeyEnv ?? '', hint: 'Recommended over inline key' },
    { name: 'apiKey',     label: 'API key (inline)', placeholder: 'sk-…', default: '', secret: true, hint: 'Optional if env var is set' },
  ]

  const values = await new Promise<any>((resolveForm) => {
    const { unmount } = render(
      React.createElement(Form, {
        title: isCustom ? 'Custom Provider' : `Configure ${preset?.name ?? selectedPresetId}`,
        fields,
        onSubmit: (vals) => { unmount(); resolveForm(vals) },
        onCancel: () => { unmount(); resolveForm(null) },
      }),
    )
  })
  if (!values) return undefined

  if (isOpenAICodex) {
    if (input.isTTY) await runCodexLoginUi(codexAuthMode ?? 'browser')
    else await loginOpenAICodex({ mode: 'device' })
    return {
      id: values.id.trim() || selectedPresetId,
      name: opts.name ?? preset?.name ?? values.id,
      type: preset.type,
      baseURL: preset.baseURL,
      apiKey: undefined,
      apiKeyEnv: undefined,
      endpoint: opts.endpoint ?? preset.endpoint,
      defaultModel: values.model.trim() || preset.defaultModel,
      models: providerModels(values.model, values.models),
      aliases: opts.alias ?? [],
    }
  }

  return {
    id: values.id.trim() || selectedPresetId,
    name: opts.name ?? preset?.name ?? values.id,
    type: values.type.trim() || preset?.type || 'openai-compatible',
    baseURL: values.baseUrl.trim() || preset?.baseURL || undefined,
    apiKey: values.apiKey.trim() || undefined,
    apiKeyEnv: values.apiKeyEnv.trim() || undefined,
    endpoint: opts.endpoint ?? preset?.endpoint,
    defaultModel: values.model.trim() || preset?.defaultModel,
    models: providerModels(values.model, values.models),
    aliases: opts.alias ?? [],
  }
}

function providerModels(defaultModel, models) {
  return [...new Set([defaultModel, models].flatMap((value) => String(value ?? '').split(',')).map((value) => value.trim()).filter(Boolean))]
}

export async function addAgentCommand(name, opts) {
  if (!name) {
    console.error('Agent name is required. Use: lannr agents add <name> <provider>')
    process.exitCode = 1
    return
  }
  if (!opts.provider) {
    console.error('Provider is required. Use: lannr agents add <name> <provider>')
    process.exitCode = 1
    return
  }

  const nonInteractive = Boolean(opts.nonInteractive) || !input.isTTY
  let agentName = name
  let workspace = opts.workspace ?? ''
  let description = opts.description ?? ''
  let instructions = opts.instructions ?? ''
  let globalReach = Boolean(opts.globalreach)
  let deniedSkills = parseSkillList(opts.denyskills ?? [])

  if (!nonInteractive && !opts.description && !opts.instructions && !opts.workspace) {
    const globalSkills = (await listSkills().catch(() => []))
      .filter((s) => s.scope === 'global')
      .map((s) => ({ name: s.name, description: s.description ?? '' }))
    const fields = [
      { name: 'workspace',    label: 'Workspace directory', placeholder: '~/.lannr/agents/<agent-id>/workspace', default: '', hint: 'Leave empty for per-agent default' },
      { name: 'description',  label: 'Purpose',             placeholder: 'Helps with local tasks', default: '' },
      { name: 'instructions', label: 'Instructions',        placeholder: 'Help the user with…',   default: '' },
      { name: 'globalReach',  label: 'Global reach',        type: 'boolean', default: Boolean(opts.globalreach), hint: 'Let this agent read & write files outside its workspace. Leave off to sandbox it to its own directory.' },
      { name: 'skills',       label: 'Global skills',       type: 'skills', skills: globalSkills, hint: 'All global skills are allowed by default. Open to deny any this agent should not use.' },
    ]

    const values = await new Promise<any>((resolveForm) => {
      const { unmount } = render(
        React.createElement(Form, {
          title: `Add agent "${name}" (provider: ${opts.provider})`,
          fields,
          onSubmit: (vals) => { unmount(); resolveForm(vals) },
          onCancel: () => { unmount(); resolveForm(null) },
        }),
      )
    })

    if (!values) {
      console.log('Agent setup cancelled.')
      return
    }

    workspace = values.workspace
    description = values.description
    instructions = values.instructions
    globalReach = Boolean(values.globalReach)
    // The skills field returns an allow-map; persist the ones the user turned off.
    const allowed = values.skills ?? {}
    deniedSkills = globalSkills.filter((s) => allowed[s.name] === false).map((s) => s.name)
  }

  const bindings = [...(opts.bind ?? [])]
  let saved
  try {
    saved = await upsertAgent({
      name: agentName,
      description,
      instructions,
      workspace: workspace || undefined,
      agentDir: opts.agentDir,
      provider: opts.provider,
      aliases: opts.alias,
      bindings,
      deniedSkills,
      globalReach,
      default: opts.default,
      overwriteWorkspaceFiles: opts.overwriteWorkspaceFiles,
    }, { failIfExists: true })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
    return
  }

  const payload = { agentId: saved.id, name: saved.name, workspace: saved.workspace, agentDir: saved.agentDir, bindings: saved.bindings, deniedSkills: saved.deniedSkills ?? [], globalReach: saved.globalReach }
  if (opts.json) { console.log(JSON.stringify(payload, null, 2)); return }
  console.log(`Agent: ${saved.id}`)
  console.log(`Workspace: ${saved.workspace}`)
  console.log(`Agent dir: ${saved.agentDir}`)
  console.log(`Provider: ${saved.provider}`)
  if (saved.deniedSkills?.length) console.log(`Denied skills: ${saved.deniedSkills.join(', ')}`)
  if (saved.globalReach) console.log('Global reach: enabled')
}

export async function mutateBindings(agentId, routes = [], mode) {
  const agents = await listAgents()
  const target = resolveAgentFromList(agents, agentId) ?? agents.find((agent) => agent.default) ?? agents[0]
  if (!target) throw new Error('No agents configured.')
  const normalizedRoutes = routes.map((route) => String(route).trim()).filter(Boolean)
  if (mode !== 'clear' && normalizedRoutes.length === 0) throw new Error('--bind is required.')
  const existing = target.bindings ?? []
  let next = existing
  let added = []
  let removed = []
  if (mode === 'add') {
    const seen = new Set(existing.map((binding) => binding.route))
    added = normalizedRoutes.filter((route) => !seen.has(route)).map((route) => ({ route }))
    next = [...existing, ...added]
  } else if (mode === 'remove') {
    const removeSet = new Set(normalizedRoutes)
    removed = existing.filter((binding) => removeSet.has(binding.route))
    next = existing.filter((binding) => !removeSet.has(binding.route))
  } else {
    removed = existing
    next = []
  }
  const agent = await updateAgent(target.id, { bindings: next })
  return { agent, added, removed }
}

export async function setIdentityCommand(opts) {
  const agents = await listAgents()
  const target = opts.agent
    ? resolveAgentFromList(agents, opts.agent)
    : opts.workspace
      ? agents.find((agent) => resolve(agent.workspace) === resolve(opts.workspace))
      : agents.find((agent) => agent.default) ?? agents[0]
  if (!target) return null
  const fileIdentity = opts.fromIdentity || opts.identityFile || (!opts.name && !opts.theme && !opts.emoji && !opts.avatar)
    ? await readIdentityFile(opts.identityFile ?? join(opts.workspace ?? target.workspace, 'IDENTITY.md')).catch(() => ({}))
    : {}
  const identity = {
    ...target.identity,
    ...fileIdentity,
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.theme ? { theme: opts.theme } : {}),
    ...(opts.emoji ? { emoji: opts.emoji } : {}),
    ...(opts.avatar ? { avatar: opts.avatar } : {}),
  }
  return updateAgent(target.id, { identity })
}

export async function runSetupInteractive() {
  printBanner()
  console.log('Setup creates one model provider and one local Lannr agent.')
  const providerId = await prompt('Provider id (example: openai): ')
  const providerAnswers = await promptForProvider({ id: providerId || 'default', opts: { alias: [] } })
  let savedProvider
  try {
    savedProvider = await upsertProvider(providerAnswers, { failIfExists: true })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
    return
  }
  await setPrimaryProvider(savedProvider.id)
  const agentName = await prompt('Agent name: ')
  const description = await prompt('Agent purpose: ')
  const instructions = await prompt('Agent instructions: ')
  let savedAgent
  try {
    savedAgent = await upsertAgent({
      name: agentName || 'Default',
      description,
      instructions,
      provider: savedProvider.id,
      default: true,
    }, { failIfExists: true })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
    return
  }
  console.log(`\nReady. Try: lannr chat --agent ${savedAgent.id}`)
}
