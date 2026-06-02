import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModelAdapter } from './model-adapter.js'

describe('provider prompt caching', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds per-request prompt cache fields to OpenAI-compatible chat requests', async () => {
    const requests: Array<{ body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init: any) => {
      requests.push({ body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    }))

    const adapter = createModelAdapter({
      id: 'openai-compatible',
      type: 'openai-compatible',
      baseURL: 'https://example.test',
      apiKey: 'test-key',
      endpoint: 'chat-completions',
      defaultModel: 'gpt-test',
      promptCacheKey: 'provider-key',
    }, 'gpt-test')

    await adapter.complete([{ role: 'user', content: 'hello' }], { promptCacheKey: 'thread-key' })

    expect(requests[0].body.prompt_cache_key).toBe('thread-key')
    expect(requests[0].body.user).toBe('thread-key')
    expect(requests[0].body.safety_identifier).toBe('thread-key')
  })

  it('adds per-request prompt cache fields to OpenAI-compatible Responses requests', async () => {
    const requests: Array<{ body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init: any) => {
      requests.push({ body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 })
    }))

    const adapter = createModelAdapter({
      id: 'openai-responses',
      type: 'openai-compatible',
      baseURL: 'https://example.test',
      apiKey: 'test-key',
      endpoint: 'responses',
      defaultModel: 'gpt-test',
      promptCacheKey: 'provider-key',
    }, 'gpt-test')

    await adapter.complete([{ role: 'user', content: 'hello' }], { promptCacheKey: 'thread-key' })

    expect(requests[0].body.prompt_cache_key).toBe('thread-key')
    expect(requests[0].body.safety_identifier).toBe('thread-key')
  })
})
