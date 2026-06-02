import React from 'react'
import { Box, render, Text } from 'ink'
import { loginOpenAICodex } from '../providers/openai-codex-auth.js'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export async function runCodexLoginUi() {
  const state = { url: '', code: '', status: 'Connecting to OpenAI…', done: false, frame: 0 }
  const view = () => React.createElement(CodexLoginPanel, state)
  const handle = render(view())
  const rerender = () => handle.rerender(view())

  const spinner = setInterval(() => {
    if (state.done) return
    state.frame = (state.frame + 1) % SPINNER_FRAMES.length
    rerender()
  }, 80)

  try {
    await loginOpenAICodex({
      log: (line) => {
        const text = String(line)
        const urlMatch = text.match(/https?:\/\/\S+/)
        const codeMatch = text.match(/code:\s*([A-Z0-9-]+)/i)
        if (urlMatch) state.url = urlMatch[0]
        if (codeMatch) state.code = codeMatch[1]
        if (/saved to/i.test(text)) state.status = 'Signed in.'
        else if (state.url && state.code) state.status = 'Waiting for browser sign-in…'
        else state.status = text.replace(/\.\.\.$/, '…')
        rerender()
      },
    })
    state.done = true
    state.status = 'Signed in.'
    rerender()
  } finally {
    clearInterval(spinner)
    handle.unmount()
  }
}

export function CodexLoginPanel({ url, code, status, done, frame = 0 }) {
  const h = React.createElement
  const mark = done ? '✓' : SPINNER_FRAMES[frame]
  const accent = done ? 'green' : 'cyan'
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: accent, paddingX: 2, paddingY: 1, marginY: 1 },
    h(Box, null,
      h(Text, { color: accent, bold: true }, `${mark}  OpenAI Codex`),
      h(Text, { color: 'gray', dimColor: true }, '  ·  sign in with ChatGPT'),
    ),
    url ? h(Box, { marginTop: 1, flexDirection: 'column' },
      h(Text, { color: 'gray' }, 'Open in your browser'),
      h(Text, { color: 'cyan', underline: true }, `  ${url}`),
    ) : null,
    code ? h(Box, { marginTop: 1, flexDirection: 'column' },
      h(Text, { color: 'gray' }, 'Enter this code'),
      h(Text, { color: 'yellow', bold: true }, `  ${code}`),
    ) : null,
    h(Box, { marginTop: 1 },
      h(Text, { color: done ? 'green' : 'gray', dimColor: !done }, done ? `${mark} ${status}` : status),
    ),
  )
}
