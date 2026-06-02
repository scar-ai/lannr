import { tool } from 'lannr-core'
import { z } from 'zod'
import { fetchWebPage, searchWeb } from '../../tools/web.js'

export function createWebTools(ctx) {
  const { toolConfig } = ctx
  return [
    tool({
      name: 'webFetch',
      description: [
        'Fetch a public HTTP(S) webpage and return readable text, title, status, final URL, and content type.',
        'Use this to inspect a specific URL. Private, local, and non-HTTP URLs are refused.',
      ].join(' '),
      input: z.object({
        url: z.string().url(),
        timeoutMs: z.number().int().min(1_000).max(30_000).default(15_000),
        maxBytes: z.number().int().min(1_000).max(1_000_000).default(512_000),
      }),
      output: z.object({
        url: z.string(),
        finalUrl: z.string(),
        status: z.number(),
        ok: z.boolean(),
        contentType: z.string(),
        title: z.string(),
        text: z.string(),
        bytes: z.number(),
        truncated: z.boolean(),
      }),
      handler: async ({ url, timeoutMs = 15_000, maxBytes = 512_000 }) => fetchWebPage({ url, timeoutMs, maxBytes }),
    }),
    tool({
      name: 'webSearch',
      description: [
        'Search the web using the provider configured by `lannr tools setup`.',
        'Use this for current information, discovery, or finding candidate URLs before webFetch.',
      ].join(' '),
      input: z.object({
        query: z.string().min(1),
        maxResults: z.number().int().min(1).max(10).default(5),
        timeoutMs: z.number().int().min(1_000).max(30_000).default(15_000),
      }),
      output: z.object({
        provider: z.enum(['exa', 'tavily']),
        query: z.string(),
        results: z.array(z.object({
          title: z.string(),
          url: z.string(),
          snippet: z.string(),
          publishedDate: z.string(),
          score: z.number().optional(),
        })),
      }),
      handler: async ({ query, maxResults = 5, timeoutMs = 15_000 }) => searchWeb({ config: toolConfig, query, maxResults, timeoutMs }),
    }),
  ]
}
