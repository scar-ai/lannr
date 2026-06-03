import {
  addProviderModels,
  getProvider,
  getPrimaryProvider,
  providerRegistryPath,
  removeProvider,
  removeProviderModels,
  setPrimaryProvider,
  setProviderDefaultModel,
  upsertProvider,
} from '../providers/registry.js'
import { loginOpenAICodex } from '../providers/openai-codex-auth.js'
import { promptCodexAuthMode, runCodexLoginUi } from '../ui/CodexLogin.js'
import { collect, listProviderCommand, prompt, promptForProvider } from '../cli/helpers.js'

export function register(program) {
  const provider = program.command('provider').alias('providers').description('Manage model providers')

  provider.command('ls')
    .alias('list')
    .description('List registered providers')
    .option('--json', 'print JSON')
    .option('--available', 'list OpenClaw provider presets available to create')
    .action(async (opts) => {
      await listProviderCommand(opts)
    })

  provider.command('primary')
    .description('Set or show the primary provider used by default')
    .argument('[id]', 'provider id or alias')
    .action(async (id) => {
      if (!id) {
        const primary = await getPrimaryProvider()
        if (!primary) {
          console.log('No primary provider set. Use: lannr provider primary <provider>')
          return
        }
        console.log(`Primary provider: ${primary.id}`)
        return
      }
      const saved = await setPrimaryProvider(id)
      if (!saved) {
        console.error(`Provider not found: ${id}`)
        process.exitCode = 1
        return
      }
      console.log(`Primary provider set to "${saved.id}"`)
    })

  provider.command('login')
    .description('Authenticate a provider')
    .argument('<id>', 'provider id')
    .option('--browser', 'sign in via the browser OAuth flow (default)')
    .option('--device-code', 'sign in by pairing a device code')
    .action(async (id, opts) => {
      if (String(id).trim().toLowerCase() !== 'openai-codex') {
        console.error('Provider login is only implemented for openai-codex.')
        process.exitCode = 1
        return
      }
      let mode: 'browser' | 'device' | undefined = opts.deviceCode ? 'device' : opts.browser ? 'browser' : undefined
      if (process.stdout.isTTY) {
        if (!mode) mode = await promptCodexAuthMode()
        await runCodexLoginUi(mode)
      } else {
        await loginOpenAICodex({ mode: mode ?? 'device' })
      }
    })

  provider.command('new')
    .alias('add')
    .description('Create or update a provider')
    .argument('[id]', 'provider id')
    .option('--name <name>', 'display name')
    .option('--type <type>', 'provider type')
    .option('--base-url <url>', 'OpenAI-compatible base URL')
    .option('--api-key <key>', 'inline API key')
    .option('--api-key-env <name>', 'environment variable that contains the API key')
    .option('--model <model>', 'default model')
    .option('--models <models>', 'additional models, comma-separated')
    .option('--endpoint <endpoint>', 'SDK endpoint mode: chat-completions, responses, codex-responses, or completions')
    .option('--alias <alias>', 'alias for this provider; can be repeated', collect, [])
    .action(async (id, opts) => {
      const answers = await promptForProvider({ id, opts })
      if (!answers) {
        console.log('Provider setup skipped.')
        return
      }
      let saved
      try {
        saved = await upsertProvider(answers, { failIfExists: true })
      } catch (error) {
        console.error(error.message)
        process.exitCode = 1
        return
      }
      console.log(`Provider "${saved.id}" saved to ${providerRegistryPath()}`)
    })

  const models = provider.command('models')
    .description('Manage saved models for a provider')

  models.command('ls')
    .alias('list')
    .description('List models for a provider')
    .argument('[id]', 'provider id or alias')
    .action(async (id) => {
      const providerId = id ?? await prompt('Provider id: ')
      const saved = await getProvider(providerId)
      if (!saved) {
        console.error(`Provider not found: ${providerId}`)
        process.exitCode = 1
        return
      }
      const modelList = saved.models?.length ? saved.models : saved.defaultModel ? [saved.defaultModel] : []
      if (modelList.length === 0) {
        console.log(`Provider "${saved.id}" has no saved models.`)
        return
      }
      for (const model of modelList) {
        const marker = model === saved.defaultModel ? '*' : ' '
        console.log(`${marker} ${model}`)
      }
    })

  models.command('add')
    .description('Add one or more models to an existing provider')
    .argument('<id>', 'provider id or alias')
    .argument('<models...>', 'model names')
    .action(async (id, modelNames) => {
      const saved = await addProviderModels(id, modelNames)
      if (!saved) {
        console.error(`Provider not found: ${id}`)
        process.exitCode = 1
        return
      }
      console.log(`Provider "${saved.id}" models: ${saved.models.join(', ')}`)
    })

  models.command('rm')
    .alias('remove')
    .description('Remove one or more models from a provider')
    .argument('<id>', 'provider id or alias')
    .argument('<models...>', 'model names')
    .action(async (id, modelNames) => {
      const saved = await removeProviderModels(id, modelNames)
      if (!saved) {
        console.error(`Provider not found: ${id}`)
        process.exitCode = 1
        return
      }
      console.log(`Provider "${saved.id}" models: ${saved.models.join(', ') || 'none'}`)
    })

  models.command('default')
    .description('Set the default model for a provider')
    .argument('<id>', 'provider id or alias')
    .argument('<model>', 'model name')
    .action(async (id, model) => {
      const saved = await setProviderDefaultModel(id, model)
      if (!saved) {
        console.error(`Provider not found: ${id}`)
        process.exitCode = 1
        return
      }
      console.log(`Provider "${saved.id}" default model set to ${saved.defaultModel}`)
    })

  provider.command('rm')
    .description('Remove a provider')
    .argument('[id]', 'provider id or alias')
    .action(async (id) => {
      const providerId = id ?? await prompt('Provider id to remove: ')
      const removed = await removeProvider(providerId)
      if (!removed) {
        console.error(`Provider not found: ${providerId}`)
        process.exitCode = 1
        return
      }
      console.log(`Provider "${removed.id}" removed from ${providerRegistryPath()}`)
    })
}
