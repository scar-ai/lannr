import { tool } from 'lannr-core'
import { z } from 'zod'
import { clarifyBus } from '../clarify-bus.js'

export function createClarifyTools(ctx) {
  return [
    tool({
      name: 'clarify',
      description: [
        'Ask the user a multiple-choice clarifying question when their request is ambiguous',
        'or you need a decision before continuing. Provide 2–6 labelled options; the UI always',
        'appends an "Other" slot so the user can type a free-text answer that none of the',
        'options covers. Use sparingly — only when guessing would meaningfully waste work or',
        'produce the wrong result. Do NOT use for trivial choices you can pick yourself.',
        'Returns { answer, selectedIndex, freeText } — selectedIndex is null if the user',
        'chose Other.',
      ].join(' '),
      input: z.object({
        question: z.string().min(1).describe('The question to show the user. One short sentence.'),
        options: z
          .array(
            z.object({
              label: z.string().min(1).describe('Short choice text (1–6 words).'),
              description: z.string().optional().describe('Optional one-line hint about what this choice implies.'),
            }),
          )
          .min(2)
          .max(6)
          .describe('Labelled answer choices. An "Other" free-text slot is added automatically.'),
        reason: z.string().optional().describe('Optional one-line context: why this matters / what is blocked.'),
      }),
      output: z.object({
        answer: z.string(),
        selectedIndex: z.number().nullable(),
        freeText: z.string().nullable(),
      }),
      handler: async ({ question, options, reason }) => {
        const result: any = await clarifyBus.ask({
          sessionId: ctx?.session ?? null,
          question,
          options,
          reason,
        })
        return {
          answer: result.answer,
          selectedIndex: result.selectedIndex,
          freeText: result.freeText,
        }
      },
    }),
  ]
}
