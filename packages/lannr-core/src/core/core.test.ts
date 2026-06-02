import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { applyDiff, buildPromptCacheKey, createLannr, extractProgram, FileReplayStore, generateDiff, MemoryReplayStore, scoreConfidence, tool, type Message } from './index.js'
import { nodeRunner } from '../runner-node/index.js'

function staticModel(responses: string[] | ((messages: Message[]) => string | Promise<string>)) {
  let index = 0
  return {
    async complete(messages: Message[]) {
      if (typeof responses === 'function') return responses(messages)
      return responses[Math.min(index++, responses.length - 1)] ?? ''
    },
  }
}

describe('lannr core', () => {
  it('extracts TypeScript programs', () => {
    expect(extractProgram('x\n<program>\nreturn 1\n</program>')).toBe('return 1')
    expect(extractProgram('x\n<program>return 1</program>')).toBe('return 1')
    expect(extractProgram('x\nreturn 1')).toBeNull()
    expect(extractProgram('x\n```ts\nreturn 1\n```')).toBeNull()
  })

  it('tells the model to answer directly for simple conversation', () => {
    const lannr = createLannr({
      runner: nodeRunner(),
      model: staticModel(''),
      tools: [],
    })
    const prompt = lannr.buildSystemPrompt()
    expect(prompt).toContain('For simple conversation or questions that do not require tools, answer directly in prose.')
    expect(prompt).toContain('Only when you need to take actions')
    expect(prompt).toContain('Do not first say that you will do it, ask for confirmation, or wait for the user to say yes.')
    expect(prompt).toContain('Do not mention retry attempts, malformed blocks, runner errors, or your debugging process')
  })

  it('builds per-thread prompt cache keys without a shared fallback', () => {
    expect(buildPromptCacheKey({ namespace: 'lannr', agentId: 'default agent', threadId: 'thread-1' })).toBe('lannr:default-agent:thread-1')
    expect(buildPromptCacheKey({ namespace: 'lannr', agentId: 'default', sessionId: ' session-1 ' })).toBe('lannr:default:session-1')
    expect(buildPromptCacheKey({ namespace: 'lannr', agentId: 'default' })).toBeUndefined()
  })

  it('forwards the SDK prompt cache key to model adapters', async () => {
    let seenOpts: any
    const lannr = createLannr({
      runner: nodeRunner(),
      model: {
        async complete(_messages, opts) {
          seenOpts = opts
          return 'ok'
        },
      },
      tools: [],
      promptCacheKey: 'lannr:default:thread-1',
    })

    await lannr.run([{ role: 'user', content: 'hello' }])

    expect(seenOpts).toMatchObject({ promptCacheKey: 'lannr:default:thread-1' })
  })

  it('normalizes object-shaped stream chunks from model adapters', async () => {
    const lannr = createLannr({
      runner: nodeRunner(),
      model: {
        async complete() { return '' },
        async *stream() {
          yield { text: 'hi' } as unknown as string
        },
      },
      tools: [],
    })
    const result = await lannr.run([{ role: 'user', content: 'hi' }])
    expect(result.answer).toBe('hi')
  })

  it('streams user-visible prose deltas', async () => {
    const lannr = createLannr({
      runner: nodeRunner(),
      model: {
        async complete() { return '' },
        async *stream() {
          yield 'he'
          yield 'llo'
        },
      },
      tools: [],
    })
    const visible = []
    for await (const event of lannr.stream([{ role: 'user', content: 'hi' }])) {
      if (event.type === 'lannr:answer:delta') visible.push(event.text)
    }
    expect(visible.join('')).toBe('hello')
  })

  it('does not stream TypeScript program drafts as user-visible deltas', async () => {
    const lannr = createLannr({
      runner: nodeRunner(),
      model: staticModel([
        '<program>\nreturn 1\n</program>',
        'done',
      ]),
      tools: [],
    })
    const visible = []
    for await (const event of lannr.stream([{ role: 'user', content: 'run' }])) {
      if (event.type === 'lannr:answer:delta') visible.push(event.text)
    }
    expect(visible.join('')).toBe('done')
  })

  it('does not stream preamble before TypeScript program drafts as user-visible deltas', async () => {
    const lannr = createLannr({
      runner: nodeRunner(),
      model: staticModel([
        'I will do that now.\n<program>\nreturn 1\n</program>',
        'done',
      ]),
      tools: [],
    })
    const visible = []
    for await (const event of lannr.stream([{ role: 'user', content: 'run' }])) {
      if (event.type === 'lannr:answer:delta') visible.push(event.text)
    }
    expect(visible.join('')).toBe('done')
  })

  it('emits model usage chunks from stream adapters', async () => {
    const lannr = createLannr({
      runner: nodeRunner(),
      model: {
        async complete() { return '' },
        async *stream() {
          yield { text: 'hi' }
          yield { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 } }
        },
      },
      tools: [],
    })
    const events = []
    for await (const event of lannr.stream([{ role: 'user', content: 'hi' }])) events.push(event)
    expect(events).toContainEqual({ type: 'lannr:model:usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 } })
  })

  it('stores only executable programs for retry history', async () => {
    let seenMessages = []
    const lannr = createLannr({
      runner: nodeRunner(),
      model: {
        async complete(messages) {
          seenMessages = messages
          return messages.some((message) => message.role === 'tool')
            ? 'final answer'
            : 'I will try this first.\n<program>\nreturn 1\n</program>'
        },
      },
      tools: [],
    })
    await lannr.run([{ role: 'user', content: 'run' }])
    expect(seenMessages.find((message) => message.role === 'assistant')?.content).toBe('<program>\nreturn 1\n</program>')
  })

  it('scores confidence', () => {
    expect(scoreConfidence(['tool_error', 'empty_result'])).toBe(0.4)
  })

  it('runs a model-generated program with bound tools', async () => {
    const lannr = createLannr({
      runner: nodeRunner(),
      model: staticModel([
        '<program>\nconst value = await $double({ value: 21 })\nreturn { value }\n</program>',
        'The value is 42.',
      ]),
      tools: [
        tool({
          name: 'double',
          input: z.object({ value: z.number() }),
          output: z.number(),
          handler: ({ value }) => value * 2,
        }),
      ],
    })
    const result = await lannr.run([{ role: 'user', content: 'double 21' }])
    expect(result.answer).toBe('The value is 42.')
  })

  it('compacts tool outputs before replaying them to the model', async () => {
    const largeContent = 'x'.repeat(30_000)
    const lannr = createLannr({
      runner: nodeRunner(),
      model: staticModel([
        '<program>\nconst value = await $large({})\nreturn { length: value.content.length }\n</program>',
        'done',
      ]),
      tools: [
        tool({
          name: 'large',
          input: z.object({}),
          output: z.object({ path: z.string(), content: z.string() }),
          outputContract: {
            maxTokens: 200,
            compress: (output) => ({ path: output.path, bytes: output.content.length }),
          },
          handler: () => ({ path: 'huge.log', content: largeContent }),
        }),
      ],
    })

    const result = await lannr.run([{ role: 'user', content: 'read huge output' }])
    const payload = JSON.parse(result.messages.at(-1)?.content ?? '{}')

    expect(payload.result).toEqual({ length: 30_000 })
    expect(payload.stats.toolCalls[0].output).toEqual({ path: 'huge.log', bytes: 30_000 })
  })

  it('applies generated unified diffs', () => {
    const before = 'const value = 1\nreturn value'
    const after = 'const value = 2\nreturn value'
    const result = applyDiff(before, generateDiff(before, after))
    expect(result).toEqual({ ok: true, program: after })
  })

  it('records and replays executions without calling tools again', async () => {
    let calls = 0
    const replayStore = new MemoryReplayStore()
    const model = staticModel([
      '<program>\nconst value = await $double({ value: 21 })\nreturn { value }\n</program>',
      'The value is 42.',
      '<program>\nconst value = await $double({ value: 21 })\nreturn { value }\n</program>',
      'The value is 42 again.',
    ])
    const lannr = createLannr({
      runner: nodeRunner(),
      replayStore,
      model,
      tools: [
        tool({
          name: 'double',
          cacheTTL: 60,
          input: z.object({ value: z.number() }),
          output: z.number(),
          handler: ({ value }) => {
            calls++
            return value * 2
          },
        }),
      ],
    })
    await lannr.run([{ role: 'user', content: 'double 21' }])
    await lannr.run([{ role: 'user', content: 'double 21' }])
    expect(calls).toBe(1)
    expect(await replayStore.list()).toHaveLength(1)
  })

  it('supports documented two-argument router invocation', async () => {
    const lannr = createLannr({
      runner: nodeRunner(),
      model: staticModel([
        '<program>\nreturn await $invoke("remote.double", { value: 21 })\n</program>',
        'done',
      ]),
      router: {
        async discover() { return [] },
        async inspect() { return {} },
        async invoke(toolId, input) {
          return { toolId, input }
        },
      },
      tools: [],
    })
    const result = await lannr.run([{ role: 'user', content: 'invoke' }])
    const payload = JSON.parse(result.messages.at(-1)?.content ?? '{}')
    expect(payload.result).toEqual({ toolId: 'remote.double', input: { value: 21 } })
  })

  it('allows agents to call configured MCP servers', async () => {
    const lannr = createLannr({
      runner: nodeRunner(),
      model: staticModel([
        '<program>\nreturn await $mcpCallTool("local", "double", { value: 21 })\n</program>',
        'done',
      ]),
      mcpServers: [{
        name: 'local',
        async listTools() { return [{ name: 'double' }] },
        async callTool(name, input) {
          return { name, input }
        },
      }],
      tools: [],
    })
    expect(lannr.buildSystemPrompt()).toContain('$mcpCallTool(server: string, name: string, input?: unknown)')
    const result = await lannr.run([{ role: 'user', content: 'invoke mcp' }])
    const payload = JSON.parse(result.messages.at(-1)?.content ?? '{}')
    expect(payload.result).toEqual({ name: 'double', input: { value: 21 } })
  })
})
