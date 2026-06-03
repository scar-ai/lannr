import { stdin as input, stdout as output } from 'node:process'
import { readFileSync, readSync } from 'node:fs'
import React from 'react'
import { render } from 'ink'
import { getPrimaryProvider, listProviders, setPrimaryProvider, upsertProvider } from './providers/registry.js'
import { defaultAgentWorkspace, listAgents, normalizeAgentId, upsertAgent } from './agents/registry.js'
import { getOpenClawProviderPreset, listOpenClawProviderCatalog } from './providers/openclaw-catalog.js'
import { promptCodexAuthMode, runCodexLoginUi } from './ui/CodexLogin.js'
import { loadToolConfig, saveToolConfig, toolConfigPath } from './tools/web.js'
import { MultiSelect } from './ui/MultiSelect.js'
import { Confirm } from './ui/Confirm.js'
import { Form, InlinePrompt } from './ui/Form.js'
import { WelcomeTour } from './ui/WelcomeTour.js'
import { runDoctorChecks } from './commands/status.js'
import { importFromHermes } from './importers/hermes.js'
import { importFromOpenClaw } from './importers/openclaw.js'

const DEFAULT_AGENT_NAME = 'Default'

const FEATURED_AUTH_CHOICES = [
  ['openai', 'OpenAI API key'],
  ['openai-codex', 'OpenAI Codex'],
  ['anthropic', 'Anthropic API key'],
  ['google', 'Google Gemini API key'],
  ['openrouter', 'OpenRouter API key'],
  ['opencode', 'OpenCode Zen catalog'],
  ['opencode-go', 'OpenCode Go catalog'],
  ['ollama', 'Ollama local server'],
  ['lmstudio', 'LM Studio local server'],
  ['custom-api-key', 'Custom Provider'],
  ['skip', 'Skip provider setup'],
]

const API_KEY_OPTION_BY_PROVIDER = {
  openai: 'openaiApiKey',
  anthropic: 'anthropicApiKey',
  google: 'googleApiKey',
  openrouter: 'openrouterApiKey',
  opencode: 'opencodeApiKey',
  'opencode-go': 'opencodeApiKey',
}

let promptInterface
let pipedAnswers

export async function runOnboard(opts: Record<string, any> = {}) {
  try {
    await runOnboardInner(opts)
  } finally {
    closePrompts()
  }
}

export async function configureProviderOnly(opts: Record<string, any> = {}) {
  try {
    preparePromptInput()
    if (!opts.nonInteractive && !opts.provider && !opts.authChoice && pipedAnswers?.length === 1 && pipedAnswers[0] === '') {
      return undefined
    }
    return configureProviderFromOnboard(opts, { flow: normalizeFlow(opts.flow) ?? 'quickstart' })
  } finally {
    closePrompts()
  }
}

export async function configureTools(opts: Record<string, any> = {}) {
  try {
    preparePromptInput()
    const existing = await loadToolConfig()
    let provider = normalizeChoice(opts.webSearchProvider ?? opts.provider)
    if (!provider && opts.nonInteractive) provider = 'skip'
    if (!provider) {
      console.log('Configure web tools')
      const wantsWebSearch = await confirm('Enable webSearch?', true)
      if (!wantsWebSearch) provider = 'skip'
      else provider = await select('Web search provider', [
        ['exa', 'Exa'],
        ['tavily', 'Tavily'],
      ], existing.webSearch?.provider ?? 'exa')
    }
    if (!provider || provider === 'skip') {
      await saveToolConfig({ ...existing, webSearch: undefined })
      console.log(`Web search disabled in ${toolConfigPath()}.`)
      return
    }
    if (!['exa', 'tavily'].includes(provider)) throw new Error('Web search provider must be exa or tavily.')

    const defaultEnv = provider === 'exa' ? 'EXA_API_KEY' : 'TAVILY_API_KEY'
    let apiKey = opts.apiKey
    let apiKeyEnv = opts.apiKeyEnv
    if (!apiKey && !apiKeyEnv && !opts.nonInteractive) {
      const useEnv = await confirm(`Use ${defaultEnv} from the environment?`, true)
      if (useEnv) {
        apiKeyEnv = defaultEnv
      } else {
        apiKey = await promptSecret(`Paste ${provider} API key: `)
      }
    }
    if (!apiKey && !apiKeyEnv) apiKeyEnv = defaultEnv

    await saveToolConfig({
      ...existing,
      webSearch: {
        provider,
        apiKey,
        apiKeyEnv,
      },
    })
    console.log(`Web tools configured in ${toolConfigPath()}.`)
    console.log(`webSearch provider: ${provider}`)
    console.log(apiKey ? 'API key: stored locally' : `API key: env:${apiKeyEnv}`)
  } finally {
    closePrompts()
  }
}

async function runOnboardInner(opts: Record<string, any> = {}) {
  printOnboardHeader()
  validateOnboardOptions(opts)
  preparePromptInput()

  if (opts.nonInteractive && opts.acceptRisk !== true) {
    throw new Error([
      'Non-interactive setup requires explicit risk acknowledgement.',
      'Re-run with: lannr onboard --non-interactive --accept-risk ...',
    ].join('\n'))
  }

  if (opts.acceptRisk !== true && !opts.nonInteractive) {
    console.log('Agents can read and write files in their configured workspace and call enabled tools.')
    const ok = await confirm('Continue with local setup?', true)
    if (!ok) {
      console.log('Setup cancelled.')
      process.exitCode = 1
      return
    }
  }

  let flow = normalizeFlow(opts.flow)
  if (!flow && !opts.nonInteractive) {
    flow = await select('Setup mode', [
      ['quickstart', 'QuickStart (recommended)'],
      ['advanced', 'Manual setup'],
    ], 'quickstart')
  }
  flow ??= 'quickstart'

  // ── Stage 1: doctor preflight ───────────────────────────────────────
  printStage(1, 'Doctor — checking your local setup')
  const preflight = await runDoctorChecks()
  if (preflight.issues.length === 0 && preflight.providerCount > 0 && preflight.agentCount > 0) {
    console.log('  ✓ Lannr setup already looks usable.')
    if (!opts.nonInteractive) {
      const action = await select('What would you like to do?', [
        ['chat', 'Jump straight into chat'],
        ['modify', 'Re-run onboarding (add provider/agent)'],
        ['quit', 'Quit'],
      ], 'chat')
      if (action === 'quit') return
      if (action === 'chat') {
        const existingAgents = await listAgents()
        const primary = await getPrimaryProvider()
        const target = existingAgents.find((a) => a.default) ?? existingAgents[0]
        printDone({ providerId: primary?.id, agentId: target?.id })
        await launchChat(target?.id)
        return
      }
    }
  } else {
    console.log(`  providers: ${preflight.providerCount}   agents: ${preflight.agentCount}`)
    for (const issue of preflight.issues) console.log(`  • ${issue}`)
    console.log("  We'll fix the rest in the next steps.")
  }

  // ── Stage 2: provider ───────────────────────────────────────────────
  printStage(2, 'Provider — connect a model')
  const importedProviders = await maybeImport(opts, 'providers')
  let configureProvider = true
  if (importedProviders > 0) {
    configureProvider = opts.nonInteractive
      ? Boolean(opts.authChoice || opts.provider)
      : Boolean(await confirm(`Imported ${importedProviders} provider(s). Configure another provider too?`, false))
  }

  let providerId
  if (configureProvider) {
    const provider = await configureProviderFromOnboard(opts, { flow })
    providerId = provider?.id
    if (provider) {
      const saved = await upsertProvider(provider)
      await setPrimaryProvider(saved.id)
      providerId = saved.id
      console.log(`  ✓ Provider "${saved.id}" configured.`)
    } else if (importedProviders === 0) {
      console.log('  ⚠ No provider configured — chat will fail until one is added.')
    }
  }
  const primaryProvider = await getPrimaryProvider()
  providerId ??= primaryProvider?.id
  if (importedProviders > 0 && !configureProvider) {
    console.log(`  ✓ Using imported provider${primaryProvider ? ` "${primaryProvider.id}"` : 's'}.`)
  }

  // ── Stage 3: first agent ────────────────────────────────────────────
  printStage(3, 'Agent — create your first agent')
  const importedAgents = await maybeImport(opts, 'agents')
  let createAgent = true
  if (importedAgents > 0) {
    createAgent = opts.nonInteractive
      ? Boolean(opts.agentName)
      : Boolean(await confirm(`Imported ${importedAgents} agent(s). Create a new agent too?`, false))
  }

  let savedAgent
  if (createAgent) {
    savedAgent = await createFirstAgent(opts, providerId ?? 'default')
    console.log(`  ✓ Agent "${savedAgent.name}" saved at ${savedAgent.workspace}`)
  } else {
    console.log('  ✓ Using imported agents — skipping new agent creation.')
  }

  const existingAgents = await listAgents()
  const targetAgent = savedAgent
    ?? existingAgents.find((a) => a.default)
    ?? existingAgents[0]

  // ── Stage 4: feature tour ───────────────────────────────────────────
  if (!opts.nonInteractive && !opts.skipTour) {
    printStage(4, 'Tour — what you can build with Lannr')
    await runWelcomeTour()
  }

  // ── Stage 5: chat handoff ───────────────────────────────────────────
  printDone({ providerId: providerId ?? 'default', agentId: targetAgent?.id })
  if (!opts.nonInteractive && !opts.skipChat && providerId && targetAgent) {
    await launchChat(targetAgent.id)
  }
}

async function maybeImport(opts, what: 'providers' | 'agents'): Promise<number> {
  const label = what === 'providers'
    ? 'Import providers from another tool?'
    : 'Import agents from another tool?'
  const source = await promptImportSource(opts, label)
  if (!source) return 0

  const importOptions = {
    source: opts.importPath,
    overwrite: Boolean(opts.overwrite),
    setPrimary: opts.setPrimary !== false,
  }
  const summary = source === 'openclaw'
    ? await importFromOpenClaw(what, importOptions)
    : await importFromHermes(what, importOptions)

  const rows = what === 'providers' ? summary.providers : summary.agents
  const count = rows.filter((row) => row.action === 'created' || row.action === 'updated').length
  console.log(`  Imported from ${summary.source} (${summary.hermesRoot})`)
  console.log(`  ${what}: ${count}`)
  for (const row of rows) console.log(`    [${row.action}] ${what === 'providers' ? 'provider' : 'agent'} ${row.id}${row.reason ? ` — ${row.reason}` : ''}`)
  for (const note of summary.notes) console.log(`    note: ${note}`)
  return count
}

async function promptImportSource(opts, label: string): Promise<'openclaw' | 'hermes' | undefined> {
  let source = normalizeChoice(opts.import)
  if (!source && opts.nonInteractive) return undefined
  if (!source) {
    source = await select(label, [
      ['skip', 'No, skip import'],
      ['openclaw', 'OpenClaw (~/.openclaw)'],
      ['hermes', 'Hermes (~/.hermes)'],
    ], 'skip')
  }
  if (!source || source === 'skip') return undefined
  if (source !== 'openclaw' && source !== 'hermes') {
    console.log(`  ⚠ Unknown import source "${source}" — skipping.`)
    return undefined
  }
  return source
}

async function createFirstAgent(opts, fallbackProviderId) {
  if (opts.agentName || opts.nonInteractive) {
    const name = opts.agentName ?? DEFAULT_AGENT_NAME
    const workspace = opts.workspace ?? defaultAgentWorkspace(normalizeAgentId(name))
    return upsertAgent({
      name,
      description: opts.agentDescription ?? 'Local Lannr agent.',
      instructions: opts.agentInstructions ?? 'Help the user with local workspace tasks.',
      workspace,
      provider: fallbackProviderId,
      default: true,
    })
  }
  if (pipedAnswers !== undefined || !input.isTTY) {
    const name = await promptWithDefault('Agent name', DEFAULT_AGENT_NAME)
    const workspace = await promptWithDefault('Workspace directory', defaultAgentWorkspace(normalizeAgentId(name)))
    const description = await promptWithDefault('Agent purpose', 'Local Lannr agent.')
    const instructions = await promptWithDefault('Agent instructions', 'Help the user with local workspace tasks.')
    return upsertAgent({ name, description, instructions, workspace, provider: fallbackProviderId, default: true })
  }
  const values = await runForm({
    title: 'New agent',
    fields: [
      { name: 'name', label: 'Name', default: DEFAULT_AGENT_NAME, hint: 'shown in the agent picker', required: true },
      { name: 'description', label: 'Purpose', default: 'Local Lannr agent.', hint: 'one line — what this agent is for' },
      { name: 'instructions', label: 'System instructions', default: 'Help the user with local workspace tasks.', hint: 'persistent system prompt' },
    ],
  })
  const workspace = defaultAgentWorkspace(normalizeAgentId(values.name))
  return upsertAgent({
    name: values.name,
    description: values.description,
    instructions: values.instructions,
    workspace,
    provider: fallbackProviderId,
    default: true,
  })
}

async function runForm({ title, fields }): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    const { unmount } = render(
      React.createElement(Form, {
        title,
        fields,
        onSubmit: (values) => { unmount(); resolve(values) },
        onCancel: () => { unmount(); reject(new Error('Setup cancelled.')) },
      }),
    )
  })
}

async function runWelcomeTour() {
  return new Promise<void>((resolve) => {
    const { unmount } = render(
      React.createElement(WelcomeTour, {
        onDone: () => { unmount(); resolve() },
      }),
    )
  })
}

async function launchChat(agentId) {
  closePrompts()
  const { runTui } = await import('./tui.js')
  await runTui({ agent: agentId })
}

function printStage(number, label) {
  console.log(`\n[${number}/5] ${label}`)
}

function preparePromptInput() {
  if (!input.isTTY && pipedAnswers === undefined) {
    pipedAnswers = readFileSync(0, 'utf8').split(/\r?\n/)
  }
}

function closePrompts() {
  promptInterface?.close()
  promptInterface = undefined
  pipedAnswers = undefined
}

async function configureProviderFromOnboard(opts, { flow }) {
  let authChoice = normalizeChoice(opts.authChoice)
  if (!authChoice && opts.nonInteractive) authChoice = normalizeChoice(opts.provider) ?? 'skip'
  if (!authChoice) {
    authChoice = flow === 'quickstart'
      ? await select('Auth provider', FEATURED_AUTH_CHOICES, 'openai')
      : await promptProviderChoice()
  }

  if (authChoice === 'skip') return undefined
  if (authChoice === 'custom-api-key') return promptCustomProvider(opts)

  const preset = getOpenClawProviderPreset(authChoice)
  if (!preset) throw new Error(`Unknown provider auth choice: ${authChoice}`)
  if (preset.unsupportedReason) {
    throw new Error(`Provider "${preset.id}" cannot be configured for local Lannr agent chat: ${preset.unsupportedReason}`)
  }
  if (preset.id === 'openai-codex') {
    if (!opts.nonInteractive) {
      const mode = normalizeCodexAuthMode(opts.codexAuthMode) ?? await promptCodexAuthMode()
      await runCodexLoginUi(mode)
    }
    const defaultModel = opts.model ?? (opts.nonInteractive ? preset.defaultModel : await promptWithDefault('Codex model', preset.defaultModel))
    return providerFromPreset(preset, { apiKey: undefined, apiKeyEnv: undefined, opts: { ...opts, model: defaultModel } })
  }
  const apiKeyOption = API_KEY_OPTION_BY_PROVIDER[preset.id]
  const explicitApiKey = apiKeyOption ? opts[apiKeyOption] : undefined
  const apiKey = explicitApiKey ?? opts.apiKey
  let apiKeyEnv = opts.apiKeyEnv ?? preset.apiKeyEnv
  if (!apiKey && preset.apiKey && !preset.apiKeyEnv) apiKeyEnv = undefined

  if (!opts.nonInteractive && !apiKey && !preset.apiKey && apiKeyEnv) {
    const useEnv = await confirm(`Use ${apiKeyEnv} for ${preset.id} auth?`, true)
    if (!useEnv) {
      const entered = await promptSecret(`Paste ${preset.id} API key (leave empty to keep env auth): `)
      if (entered) {
        return providerFromPreset(preset, { apiKey: entered, apiKeyEnv: undefined, opts })
      }
      apiKeyEnv = await promptWithDefault('API key env var', apiKeyEnv)
    }
  }

  return providerFromPreset(preset, { apiKey, apiKeyEnv, opts })
}

function providerFromPreset(preset, { apiKey, apiKeyEnv, opts }) {
  return {
    id: preset.id,
    name: opts.name ?? preset.name,
    type: opts.type ?? preset.type,
    baseURL: opts.baseUrl ?? preset.baseURL,
    apiKey: apiKey ?? preset.apiKey,
    apiKeyEnv,
    endpoint: opts.endpoint ?? preset.endpoint,
    defaultModel: opts.model ?? preset.defaultModel,
    models: providerModels(opts.model ?? preset.defaultModel, opts.models),
    aliases: opts.alias ?? [],
  }
}

async function promptCustomProvider(opts) {
  const id = opts.customProviderId ?? opts.provider ?? await promptWithDefault('Provider id', 'custom')
  const compatibility = normalizeCustomCompatibility(opts.customCompatibility) ?? (opts.nonInteractive ? 'openai-compatible' : await select('API compatibility', [
    ['openai-compatible', 'OpenAI compatible'],
    ['anthropic', 'Anthropic messages compatible'],
    ['google', 'Google Gemini compatible'],
  ], 'openai-compatible'))
  const baseURL = opts.customBaseUrl ?? opts.baseUrl ?? await prompt('Base URL: ')
  const defaultModel = opts.customModelId ?? opts.model ?? await prompt('Default model: ')
  const apiKey = opts.customApiKey ?? opts.apiKey
  let apiKeyEnv = opts.apiKeyEnv
  let inlineKey = apiKey
  if (!inlineKey && !apiKeyEnv && !opts.nonInteractive) {
    apiKeyEnv = await prompt('API key env var (leave empty to paste key): ')
    if (!apiKeyEnv) inlineKey = await promptSecret('API key (leave empty for no auth): ')
  }
  return {
    id,
    name: opts.name ?? id,
    type: compatibility,
    baseURL,
    apiKey: inlineKey,
    apiKeyEnv,
    endpoint: opts.endpoint ?? 'chat-completions',
    defaultModel,
    models: providerModels(defaultModel, opts.models),
    aliases: opts.alias ?? [],
  }
}

function providerModels(defaultModel, models) {
  return [...new Set([defaultModel, models].flatMap((value) => String(value ?? '').split(',')).map((value) => value.trim()).filter(Boolean))]
}

async function promptProviderChoice() {
  const catalog = listOpenClawProviderCatalog().filter((provider) => !provider.unsupportedReason)
  console.log('\nAvailable local model providers')
  catalog.forEach((provider, index) => {
    console.log(`${index + 1}. ${provider.id} (${provider.type})`)
  })
  console.log(`${catalog.length + 1}. custom-api-key`)
  console.log(`${catalog.length + 2}. skip`)
  const answer = await prompt('Auth provider: ')
  const index = Number.parseInt(answer, 10)
  if (Number.isInteger(index) && index >= 1 && index <= catalog.length) return catalog[index - 1].id
  if (index === catalog.length + 1) return 'custom-api-key'
  if (index === catalog.length + 2) return 'skip'
  return normalizeChoice(answer)
}

function validateOnboardOptions(opts) {
  if (opts.flow && !['quickstart', 'advanced', 'manual'].includes(opts.flow)) {
    throw new Error('Invalid --flow. Use quickstart, manual, or advanced.')
  }
  if (opts.mode && opts.mode !== 'local') {
    throw new Error('Lannr CLI onboard only supports local mode. Gateway/channel/remote setup is intentionally not included.')
  }
}

function normalizeFlow(flow) {
  if (!flow) return undefined
  return flow === 'manual' ? 'advanced' : flow
}

function normalizeChoice(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'custom' || normalized === 'custom-provider') return 'custom-api-key'
  return normalized
}

function normalizeCodexAuthMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'device' || normalized === 'device-code' || normalized === 'devicecode') return 'device'
  if (normalized === 'browser' || normalized === 'oauth' || normalized === 'web') return 'browser'
  return undefined
}

function normalizeCustomCompatibility(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'openai') return 'openai-compatible'
  return normalized
}

function printOnboardHeader() {
  console.log('')
  console.log('\x1b[1m\x1b[35m✦ lannr\x1b[0m \x1b[2m— let\'s set things up\x1b[0m')
}

function printDone({ providerId, agentId }) {
  console.log('\n✓ Setup complete.')
  if (providerId) console.log(`  primary provider: ${providerId}`)
  if (agentId) console.log(`  default agent:    ${agentId}`)
  console.log('  next: lannr chat   •   lannr run "..."   •   lannr doctor')
}

async function select(message, options, initialValue) {
  if (pipedAnswers !== undefined || !input.isTTY) {
    const answer = await prompt(`${message} (${options.map(([v]) => v).join('/')}): `)
    if (!answer && initialValue) return initialValue
    const index = Number.parseInt(answer, 10)
    if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1][0]
    const normalized = normalizeChoice(answer)
    if (options.some(([value]) => value === normalized)) return normalized
    return initialValue ?? options[0][0]
  }
  const items = options.map(([value, label]) => ({ value, label }))
  return new Promise(resolve => {
    const { unmount } = render(
      React.createElement(MultiSelect, {
        label: message,
        items,
        initialValue,
        onSelect: item => { unmount(); resolve(item.value) },
      })
    )
  })
}

async function confirm(message, initialValue = false) {
  if (pipedAnswers !== undefined || !input.isTTY) {
    const suffix = initialValue ? ' [Y/n] ' : ' [y/N] '
    const answer = (await prompt(`${message}${suffix}`)).toLowerCase()
    if (!answer) return initialValue
    return answer === 'y' || answer === 'yes'
  }
  return new Promise(resolve => {
    const { unmount } = render(
      React.createElement(Confirm, {
        message,
        initialValue,
        onConfirm: value => { unmount(); resolve(value) },
      })
    )
  })
}

async function promptWithDefault(message, initialValue) {
  if (pipedAnswers !== undefined || !input.isTTY) {
    const answer = await prompt(`${message} (${initialValue}): `)
    return answer || initialValue
  }
  return new Promise(resolve => {
    const { unmount } = render(
      React.createElement(InlinePrompt, {
        label: message,
        defaultValue: initialValue,
        onSubmit: value => { unmount(); resolve(value || initialValue) },
      })
    )
  })
}

async function promptSecret(question) {
  if (pipedAnswers !== undefined || !input.isTTY) return prompt(question)
  return new Promise(resolve => {
    const { unmount } = render(
      React.createElement(InlinePrompt, {
        label: question,
        secret: true,
        onSubmit: value => { unmount(); resolve(value) },
      })
    )
  })
}

async function prompt(question) {
  if (pipedAnswers !== undefined) {
    const answer = pipedAnswers.shift() ?? ''
    output.write(question)
    output.write(`${answer}\n`)
    return answer.trim()
  }
  if (!input.isTTY) {
    output.write(question)
    output.write('\n')
    return ''
  }
  return readTtyLine(question)
}

function readTtyLine(question) {
  output.write(question)
  const chunks = []
  const buffer = Buffer.alloc(1024)
  while (true) {
    let bytes
    try {
      bytes = readSync(0, buffer, 0, buffer.length, null)
    } catch (error) {
      if (error?.code === 'EAGAIN') {
        wait(20)
        continue
      }
      throw error
    }
    if (bytes <= 0) break
    const chunk = buffer.subarray(0, bytes).toString('utf8')
    chunks.push(chunk)
    if (chunk.includes('\n')) break
  }
  return chunks.join('').replace(/\r?\n[\s\S]*$/, '').trim()
}

function wait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
