// Multiple-choice prompt the model can raise via the `clarify` tool. An
// "Other" option is always appended so the user can answer freely even when
// none of the model's choices fit. Submitting resolves the awaiting tool
// handler (see src/agents/clarify-bus.js).

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { LineEditor } from './LineEditor.js'
import { theme } from './theme.js'

const h = React.createElement

const OTHER_LABEL = 'Other (type a free-text answer)'

export function ClarifyPrompt({ request, onAnswer, onCancel }) {
  const c = theme()
  const choices = request.options ?? []
  const totalChoices = choices.length + 1 // + Other
  const otherIndex = choices.length

  const [index, setIndex] = useState(0)
  const [mode, setMode] = useState('select') // 'select' | 'freeText'
  const [text, setText] = useState('')

  // Submit the free-text answer (Enter from the LineEditor).
  const submitFreeText = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    onAnswer({ answer: trimmed, selectedIndex: null, freeText: trimmed })
  }

  useInput((input, key) => {
    if (mode === 'select') {
      if (key.upArrow) {
        setIndex((i) => (i - 1 + totalChoices) % totalChoices)
        return
      }
      if (key.downArrow) {
        setIndex((i) => (i + 1) % totalChoices)
        return
      }
      if (key.return) {
        if (index === otherIndex) {
          setMode('freeText')
          return
        }
        const picked = choices[index]
        onAnswer({
          answer: picked.label,
          selectedIndex: index,
          freeText: null,
        })
        return
      }
      if (key.escape) {
        onCancel?.()
        return
      }
      // Number shortcuts 1..N for the labelled options.
      const digit = Number.parseInt(input, 10)
      if (Number.isInteger(digit) && digit >= 1 && digit <= choices.length) {
        const picked = choices[digit - 1]
        onAnswer({
          answer: picked.label,
          selectedIndex: digit - 1,
          freeText: null,
        })
        return
      }
      if (input?.toLowerCase() === 'o') {
        setMode('freeText')
        return
      }
      return
    }

    // freeText mode: text editing is owned by the LineEditor below; here we
    // only handle escape to return to the option list.
    if (key.escape) {
      setMode('select')
      setText('')
      return
    }
  })

  const header = h(Box, { flexDirection: 'column' },
    h(Box, null,
      h(Text, { color: c.assistant, bold: true }, '? '),
      h(Text, { color: c.assistant, bold: true }, 'Lannr needs your input'),
    ),
    h(Box, { paddingLeft: 2, marginTop: 0 },
      h(Text, { color: c.text, wrap: 'wrap' }, request.question || ''),
    ),
    request.reason ? h(Box, { paddingLeft: 2 },
      h(Text, { color: c.dim, dimColor: true, wrap: 'wrap' }, request.reason),
    ) : null,
  )

  if (mode === 'select') {
    return h(Box, {
      flexDirection: 'column',
      marginY: 1,
      paddingX: 1,
      borderStyle: 'round',
      borderColor: c.assistant,
    },
      header,
      h(Box, { flexDirection: 'column', marginTop: 1 },
        ...choices.map((opt, i) => {
          const active = i === index
          return h(Box, { key: `opt-${i}`, paddingX: 1 },
            h(Text, { color: active ? c.accent : c.muted }, active ? '❯ ' : '  '),
            h(Text, { color: c.dim, dimColor: true }, `${i + 1}. `),
            h(Text, { color: active ? c.text : c.muted, bold: active }, opt.label),
            opt.description ? h(Text, { color: c.dim, dimColor: true }, ` — ${opt.description}`) : null,
          )
        }),
        h(Box, { paddingX: 1 },
          h(Text, { color: index === otherIndex ? c.accent : c.muted }, index === otherIndex ? '❯ ' : '  '),
          h(Text, { color: c.dim, dimColor: true }, 'o. '),
          h(Text, { color: index === otherIndex ? c.warn : c.muted, bold: index === otherIndex }, OTHER_LABEL),
        ),
      ),
      h(Box, { marginTop: 1, paddingX: 1 },
        h(Text, { color: c.dim, dimColor: true },
          '↑↓ navigate · 1–9/o quick-pick · ↵ select · esc dismiss',
        ),
      ),
    )
  }

  // freeText mode
  return h(Box, {
    flexDirection: 'column',
    marginY: 1,
    paddingX: 1,
    borderStyle: 'round',
    borderColor: c.warn,
  },
    header,
    h(Box, { marginTop: 1, paddingX: 1 },
      h(Text, { color: c.warn, bold: true }, 'Other › '),
      h(LineEditor, {
        value: text,
        onChange: setText,
        onSubmit: submitFreeText,
        placeholder: 'type your answer…',
      }),
    ),
    h(Box, { marginTop: 1, paddingX: 1 },
      h(Text, { color: c.dim, dimColor: true }, '↵ submit · esc back to options'),
    ),
  )
}
