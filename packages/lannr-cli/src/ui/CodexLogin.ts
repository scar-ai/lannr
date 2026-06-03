import React from 'react'
import { Box, render, Text } from 'ink'
import { loginOpenAICodex } from '../providers/openai-codex-auth.js'
import { MultiSelect } from './MultiSelect.js'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const CODEX_AUTH_MODE_ITEMS = [
  { value: 'browser', label: 'Browser sign-in (recommended)', hint: 'Opens your browser and completes login automatically' },
  { value: 'device', label: 'Device pairing code', hint: 'Enter a code on chatgpt.com — useful on headless/remote hosts' },
]

export type CodexAuthMode = 'browser' | 'device'

export async function promptCodexAuthMode(initialValue: CodexAuthMode = 'browser'): Promise<CodexAuthMode> {
  if (!process.stdin.isTTY) return initialValue
  return new Promise<CodexAuthMode>((resolve) => {
    const { unmount } = render(
      React.createElement(MultiSelect, {
        label: 'How would you like to sign in to OpenAI Codex?',
        items: CODEX_AUTH_MODE_ITEMS,
        initialValue,
        onSelect: (item) => { unmount(); resolve(item.value as CodexAuthMode) },
        onCancel: () => { unmount(); resolve(initialValue) },
      }),
    )
  })
}

export async function runCodexLoginUi(mode: CodexAuthMode = 'browser') {
  const state = { url: '', code: '', status: 'Connecting to OpenAI…', done: false, frame: 0, mode }
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
      mode,
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

export function CodexLoginPanel({ url, code, status, done, frame = 0, mode = 'browser' }) {
  const h = React.createElement
  const mark = done ? '✓' : SPINNER_FRAMES[frame]
  const accent = done ? 'green' : 'cyan'
  const subtitle = mode === 'device' ? '  ·  device pairing code' : '  ·  browser sign-in'
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: accent, paddingX: 2, paddingY: 1, marginY: 1 },
    h(Box, null,
      h(Text, { color: accent, bold: true }, `${mark}  OpenAI Codex`),
      h(Text, { color: 'gray', dimColor: true }, subtitle),
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
