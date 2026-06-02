// Multiple-choice prompt the model can raise via the `clarify` tool. An
// "Other" option is always appended so the user can answer freely even when
// none of the model's choices fit. Submitting resolves the awaiting tool
// handler (see src/agents/clarify-bus.js).

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

const h = React.createElement

const OTHER_LABEL = 'Other (type a free-text answer)'

export function ClarifyPrompt({ request, onAnswer, onCancel }) {
  const choices = request.options ?? []
  const totalChoices = choices.length + 1 // + Other
  const otherIndex = choices.length

  const [index, setIndex] = useState(0)
  const [mode, setMode] = useState('select') // 'select' | 'freeText'
  const [text, setText] = useState('')
  const [cursor, setCursor] = useState(0)

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

    // freeText mode
    if (key.escape) {
      setMode('select')
      setText('')
      setCursor(0)
      return
    }
    if (key.return) {
      const trimmed = text.trim()
      if (!trimmed) return
      onAnswer({
        answer: trimmed,
        selectedIndex: null,
        freeText: trimmed,
      })
      return
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1))
      return
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(text.length, c + 1))
      return
    }
    if (key.backspace || key.delete) {
      if (cursor === 0) return
      setText(text.slice(0, cursor - 1) + text.slice(cursor))
      setCursor(cursor - 1)
      return
    }
    if (key.ctrl && input === 'a') { setCursor(0); return }
    if (key.ctrl && input === 'e') { setCursor(text.length); return }
    if (key.ctrl && input === 'u') {
      setText(text.slice(cursor))
      setCursor(0)
      return
    }
    if (key.ctrl) return
    if (!input) return
    if (input.charCodeAt(0) === 0x1b) return
    setText(text.slice(0, cursor) + input + text.slice(cursor))
    setCursor(cursor + input.length)
  })

  const header = h(Box, { flexDirection: 'column' },
    h(Box, null,
      h(Text, { color: 'magenta', bold: true }, '? '),
      h(Text, { color: 'magenta', bold: true }, 'Lannr needs your input'),
    ),
    h(Box, { paddingLeft: 2, marginTop: 0 },
      h(Text, { wrap: 'wrap' }, request.question || ''),
    ),
    request.reason ? h(Box, { paddingLeft: 2 },
      h(Text, { color: 'gray', dimColor: true, wrap: 'wrap' }, request.reason),
    ) : null,
  )

  if (mode === 'select') {
    return h(Box, {
      flexDirection: 'column',
      marginY: 1,
      paddingX: 1,
      borderStyle: 'round',
      borderColor: 'magenta',
    },
      header,
      h(Box, { flexDirection: 'column', marginTop: 1 },
        ...choices.map((opt, i) => {
          const active = i === index
          return h(Box, { key: `opt-${i}`, paddingX: 1 },
            h(Text, { color: active ? 'cyan' : 'gray' }, active ? '❯ ' : '  '),
            h(Text, { color: 'gray', dimColor: true }, `${i + 1}. `),
            h(Text, { color: active ? 'white' : 'gray', bold: active }, opt.label),
            opt.description ? h(Text, { color: 'gray', dimColor: true }, ` — ${opt.description}`) : null,
          )
        }),
        h(Box, { paddingX: 1 },
          h(Text, { color: index === otherIndex ? 'cyan' : 'gray' }, index === otherIndex ? '❯ ' : '  '),
          h(Text, { color: 'gray', dimColor: true }, 'o. '),
          h(Text, { color: index === otherIndex ? 'yellow' : 'gray', bold: index === otherIndex }, OTHER_LABEL),
        ),
      ),
      h(Box, { marginTop: 1, paddingX: 1 },
        h(Text, { color: 'gray', dimColor: true },
          '↑↓ navigate · 1–9/o quick-pick · ↵ select · esc dismiss',
        ),
      ),
    )
  }

  // freeText mode
  const cursorChar = text.slice(cursor, cursor + 1) || ' '
  return h(Box, {
    flexDirection: 'column',
    marginY: 1,
    paddingX: 1,
    borderStyle: 'round',
    borderColor: 'yellow',
  },
    header,
    h(Box, { marginTop: 1, paddingX: 1 },
      h(Text, { color: 'yellow', bold: true }, 'Other › '),
      text ? h(Box, null,
        h(Text, null, text.slice(0, cursor)),
        h(Text, { inverse: true }, cursorChar),
        h(Text, null, text.slice(cursor + 1)),
      ) : h(Box, null,
        h(Text, { inverse: true }, ' '),
        h(Text, { color: 'gray', dimColor: true }, 'type your answer…'),
      ),
    ),
    h(Box, { marginTop: 1, paddingX: 1 },
      h(Text, { color: 'gray', dimColor: true }, '↵ submit · esc back to options'),
    ),
  )
}
