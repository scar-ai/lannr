import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addProviderModels,
  getProvider,
  readRegistry,
  removeProviderModels,
  setProviderDefaultModel,
} from './registry.js'

let tempDirs: string[] = []

describe('provider registry models', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
    tempDirs = []
  })

  it('normalizes legacy single-model providers into a model list', async () => {
    const path = await registryPath()
    await writeFile(path, JSON.stringify({
      providers: [{ id: 'openai', model: 'gpt-4.1' }],
      primaryProviderId: 'openai',
    }))

    const registry = await readRegistry({ path })

    expect(registry.providers[0].defaultModel).toBe('gpt-4.1')
    expect(registry.providers[0].models).toEqual(['gpt-4.1'])
  })

  it('adds, removes, and defaults provider models without replacing the provider', async () => {
    const path = await registryPath()
    await writeFile(path, JSON.stringify({
      providers: [{ id: 'openai', defaultModel: 'gpt-4.1', models: ['gpt-4.1'] }],
      primaryProviderId: 'openai',
    }))

    await addProviderModels('openai', ['gpt-4.1-mini', 'gpt-4.1'], { path })
    await setProviderDefaultModel('openai', 'gpt-4.1-mini', { path })
    await removeProviderModels('openai', ['gpt-4.1'], { path })
    const provider = await getProvider('openai', { path })

    expect(provider.defaultModel).toBe('gpt-4.1-mini')
    expect(provider.models).toEqual(['gpt-4.1-mini'])
  })
})

async function registryPath() {
  const dir = await mkdtemp(join(tmpdir(), 'lannr-providers-'))
  tempDirs.push(dir)
  return join(dir, 'providers.json')
}
