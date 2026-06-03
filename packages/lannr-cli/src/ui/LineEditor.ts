// Shared single-line readline editor. Gives every text field in the app the
// same muscle-memory cursor motion the main chat InputBar has, so onboarding,
// forms, the agent editor, and clarify prompts all behave like a real TTY.
//
// Key map (works in Apple Terminal + iTerm2 with default settings):
//   ← / →                  char left / right
//   ⌥+← / ⌥+→             word back / forward                (Esc+ option mode)
//   Ctrl+← / Ctrl+→        word back / forward                (xterm style)
//   ⌘+← / ⌘+→             line start / end                   (iTerm default sends Ctrl+A/E)
//   Home / End             line start / end
//   Ctrl+A / Ctrl+E        line start / end
//   Backspace              delete char left
//   ⌥+Backspace            delete word left
//   Ctrl+W                 delete word left
//   Ctrl+U                 delete to line start
//   Ctrl+K                 delete to line end
//   Enter                  submit
//
// Tab / Esc / Ctrl+C are left untouched so parent screens can own
// navigation / cancel / quit.

import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'

const h = React.createElement

const WORD_RE = /\w/

export function nextWordBoundary(text, from) {
  let pos = Math.min(from, text.length)
  while (pos < text.length && !WORD_RE.test(text[pos])) pos++
  while (pos < text.length && WORD_RE.test(text[pos])) pos++
  return pos
}

export function prevWordBoundary(text, from) {
  let pos = Math.max(0, from)
  while (pos > 0 && !WORD_RE.test(text[pos - 1])) pos--
  while (pos > 0 && WORD_RE.test(text[pos - 1])) pos--
  return pos
}

// Some terminals emit Home/End as raw escape sequences ink doesn't surface.
export function isHomeSeq(input) {
  return input === '\x1b[H' || input === '\x1bOH' || input === '\x1b[1~' || input === '\x1b[7~'
}
export function isEndSeq(input) {
  return input === '\x1b[F' || input === '\x1bOF' || input === '\x1b[4~' || input === '\x1b[8~'
}

// macOS Terminal + iTerm2 with "Esc+" option mode (the default) emit
//   Option+Left  → ESC b   Option+Right → ESC f
// Other terminals send the xterm modifier form
//   Option/Ctrl+Left  → \x1b[1;3D / \x1b[1;5D   (Right → ...C)
// Ink doesn't decode either as arrow keys, so detect them explicitly.
export function isWordLeftSeq(input, key) {
  if (key.meta && (input === 'b' || input === 'B')) return true
  return input === '\x1b[1;3D' || input === '\x1b[1;5D' || input === '\x1bb'
}
export function isWordRightSeq(input, key) {
  if (key.meta && (input === 'f' || input === 'F')) return true
  return input === '\x1b[1;3C' || input === '\x1b[1;5C' || input === '\x1bf'
}

// Controlled single-line text editor. Owns its own cursor; `value`/`onChange`
// keep the text in the parent. `onSubmit` fires on Enter. `mask` (e.g. '*')
// hides the rendered characters for secret fields. `isActive` gates the input
// hook so unmounted/inactive instances don't grab keystrokes.
export function LineEditor({ value, onChange, onSubmit, placeholder = '', mask, isActive = true }) {
  const text = value ?? ''
  const [cursor, setCursor] = useState(text.length)

  // Clamp the cursor when `value` mutates from outside (e.g. parent reset).
  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, text.length)))
  }, [text])

  useInput((input, key) => {
    // Leave navigation / cancel / quit to the parent screen.
    if (key.tab || key.escape) return
    if (key.ctrl && input === 'c') return

    if (key.return) { onSubmit?.(text); return }

    // Raw Home/End escape sequences some terminals send.
    if (isHomeSeq(input)) { setCursor(0); return }
    if (isEndSeq(input)) { setCursor(text.length); return }

    // Option/Ctrl+arrow word-jump sequences that bypass ink's arrow parsing.
    if (isWordLeftSeq(input, key)) { setCursor(prevWordBoundary(text, cursor)); return }
    if (isWordRightSeq(input, key)) { setCursor(nextWordBoundary(text, cursor)); return }

    if (key.leftArrow) {
      setCursor(key.meta || key.ctrl ? prevWordBoundary(text, cursor) : Math.max(0, cursor - 1))
      return
    }
    if (key.rightArrow) {
      setCursor(key.meta || key.ctrl ? nextWordBoundary(text, cursor) : Math.min(text.length, cursor + 1))
      return
    }
    // Single-line field: ignore vertical motion so the parent can use it.
    if (key.upArrow || key.downArrow) return

    if (key.ctrl && input === 'a') { setCursor(0); return }
    if (key.ctrl && input === 'e') { setCursor(text.length); return }
    if (key.ctrl && input === 'u') { onChange?.(text.slice(cursor)); setCursor(0); return }
    if (key.ctrl && input === 'k') { onChange?.(text.slice(0, cursor)); return }
    if (key.ctrl && input === 'w') {
      const start = prevWordBoundary(text, cursor)
      onChange?.(text.slice(0, start) + text.slice(cursor))
      setCursor(start)
      return
    }

    // Ink reports Backspace as `key.delete` (0x7f); treat both as delete-left.
    if (key.backspace || key.delete) {
      if (cursor === 0) return
      if (key.meta) {
        const start = prevWordBoundary(text, cursor)
        onChange?.(text.slice(0, start) + text.slice(cursor))
        setCursor(start)
      } else {
        onChange?.(text.slice(0, cursor - 1) + text.slice(cursor))
        setCursor(cursor - 1)
      }
      return
    }

    // Drop other control / escape sequences silently.
    if (key.ctrl) return
    if (!input) return
    if (input.charCodeAt(0) === 0x1b) return

    onChange?.(text.slice(0, cursor) + input + text.slice(cursor))
    setCursor(cursor + input.length)
  }, { isActive })

  return renderLine(text, cursor, placeholder, mask)
}

function renderLine(value, cursor, placeholder, mask) {
  if (!value) {
    return h(Box, null,
      h(Text, { inverse: true }, ' '),
      placeholder ? h(Text, { color: 'gray', dimColor: true }, placeholder) : null
    )
  }
  const shown = mask ? mask.repeat(value.length) : value
  const safe = Math.max(0, Math.min(cursor, value.length))
  const before = shown.slice(0, safe)
  const at = shown.slice(safe, safe + 1) || ' '
  const after = shown.slice(safe + 1)
  return h(Box, null,
    before ? h(Text, null, before) : null,
    h(Text, { inverse: true }, at),
    after ? h(Text, null, after) : null
  )
}
