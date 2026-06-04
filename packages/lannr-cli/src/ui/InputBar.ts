// Readline-style chat input. Replaces ink-text-input so the prompt feels
// like a real TTY: word-jumps, line motion, kill/yank shortcuts, all the
// muscle-memory bindings users expect from bash/zsh/readline.
//
// Key map (works in Apple Terminal + iTerm2 with default settings):
//   ← / →                  char left / right
//   ⌥+← / ⌥+→             word back / forward                (Esc+ option mode)
//   Ctrl+← / Ctrl+→        word back / forward                (xterm style)
//   ⌘+← / ⌘+→             line start / end                   (iTerm default sends Ctrl+A/E)
//   Ctrl+A / Ctrl+E        line start / end
//   Backspace              delete char left
//   ⌥+Backspace            delete word left
//   Delete (Fn+Backspace)  delete char right
//   Ctrl+W                 delete word left
//   Ctrl+U                 delete to line start
//   Ctrl+K                 delete to line end
//   Enter                  submit
//   Shift+Enter            insert newline
//
// Tab / Esc / Ctrl+C are intentionally left untouched so the parent
// ChatApp can own autocomplete / stream-cancel / quit.

import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import {
  nextWordBoundary,
  prevWordBoundary,
  isHomeSeq,
  isEndSeq,
  isWordLeftSeq,
  isWordRightSeq,
} from './LineEditor.js'
import { theme } from './theme.js'

const h = React.createElement

// Most rows the suggestion dropdown will draw before it starts scrolling.
const MAX_VISIBLE_SUGGESTIONS = 8

export function InputBar({
  value,
  onChange,
  onSubmit,
  isStreaming,
  suggestions,
  suggestionIdx,
  queuedCount,
  paused,
  cursorBump,
  historyRef,
}) {
  const c = theme()
  const placeholder = isStreaming
    ? 'Type to queue a message  (sent when current turn finishes)'
    : 'Send a message  (/help · !cmd for shell · drag in images)'

  const [cursor, setCursor] = useState(value.length)

  // First suggestion index drawn in the dropdown. Scrolls to keep the
  // highlighted row in view once the list grows past MAX_VISIBLE_SUGGESTIONS,
  // so wrapping past the top/bottom row reveals the hidden commands instead of
  // running the selection off-frame.
  const [suggestionWindowStart, setSuggestionWindowStart] = useState(0)
  useEffect(() => {
    setSuggestionWindowStart((start) => {
      const maxStart = Math.max(0, suggestions.length - MAX_VISIBLE_SUGGESTIONS)
      let next = Math.min(start, maxStart)
      if (suggestionIdx < next) next = suggestionIdx
      else if (suggestionIdx >= next + MAX_VISIBLE_SUGGESTIONS) {
        next = suggestionIdx - MAX_VISIBLE_SUGGESTIONS + 1
      }
      return Math.min(Math.max(0, next), maxStart)
    })
  }, [suggestionIdx, suggestions.length])

  // Shell-style ↑/↓ recall. `histIdx` is the position in historyRef.current we
  // are showing (0 = oldest), or null when on the live draft. `draftRef` holds
  // the in-progress text so stepping back down past the newest entry restores it.
  const [histIdx, setHistIdx] = React.useState(null)
  const draftRef = React.useRef('')

  // Recall the previous (older) history entry. Used by ↑ at the top row.
  const recallPrev = () => {
    const hist = historyRef?.current
    if (!hist || hist.length === 0) return
    let idx
    if (histIdx === null) {
      draftRef.current = value
      idx = hist.length - 1
    } else {
      idx = Math.max(0, histIdx - 1)
    }
    setHistIdx(idx)
    const entry = hist[idx]
    onChange?.(entry)
    setCursor(entry.length)
  }

  // Recall the next (newer) entry, or the live draft once past the newest.
  // Used by ↓ at the bottom row. No-op when already on the draft.
  const recallNext = () => {
    const hist = historyRef?.current
    if (!hist || histIdx === null) return
    if (histIdx >= hist.length - 1) {
      setHistIdx(null)
      onChange?.(draftRef.current)
      setCursor(draftRef.current.length)
      return
    }
    const idx = histIdx + 1
    setHistIdx(idx)
    const entry = hist[idx]
    onChange?.(entry)
    setCursor(entry.length)
  }

  // Keep the cursor sane when `value` mutates from outside (e.g. tab-complete
  // dropping a slash command, or autocomplete dismissal resetting the field).
  useEffect(() => {
    setCursor((c) => {
      if (c > value.length) return value.length
      if (c < 0) return 0
      return c
    })
  }, [value])

  // Tab-complete bumps this counter — jump the cursor to the end so the user
  // can keep typing right after the inserted command.
  useEffect(() => {
    setCursor(value.length)
  }, [cursorBump])

  useInput((input, key) => {
    // Parent overlay (e.g. clarify prompt) owns the keyboard — go silent.
    if (paused) return
    // Hands off to parent ChatApp — these are owned there.
    if (key.tab) return
    if (key.escape) return
    if (key.ctrl && input === 'c') return
    // While suggestions are open, parent owns ↑/↓ for list navigation.
    if (suggestions.length > 0 && (key.upArrow || key.downArrow)) return

    if (key.return) {
      // Shift+Enter inserts a newline instead of submitting (when the terminal
      // reports the modifier). Many terminals also deliver a bare newline (\n,
      // 0x0a) for Shift/Option+Enter while a plain Enter arrives as \r — treat
      // that as a line break too.
      if (key.shift || input === '\n') {
        setHistIdx(null)
        onChange?.(value.slice(0, cursor) + '\n' + value.slice(cursor))
        setCursor(cursor + 1)
        return
      }
      // Parent ChatApp owns Enter when slash-command suggestions are open
      // (it submits the highlighted command directly).
      if (suggestions.length > 0) return
      onSubmit?.(value)
      return
    }

    // Raw Home/End escape sequences some terminals send.
    if (isHomeSeq(input)) { setCursor(0); return }
    if (isEndSeq(input)) { setCursor(value.length); return }

    // Option+arrow sequences that bypass ink's arrow-key parsing.
    if (isWordLeftSeq(input, key)) { setCursor(prevWordBoundary(value, cursor)); return }
    if (isWordRightSeq(input, key)) { setCursor(nextWordBoundary(value, cursor)); return }

    if (key.leftArrow) {
      if (key.meta || key.ctrl) setCursor(prevWordBoundary(value, cursor))
      else setCursor(Math.max(0, cursor - 1))
      return
    }
    if (key.rightArrow) {
      if (key.meta || key.ctrl) setCursor(nextWordBoundary(value, cursor))
      else setCursor(Math.min(value.length, cursor + 1))
      return
    }
    // ↑ at the top row recalls the previous entry; ↓ at the bottom row the
    // next. When the cursor is on an interior row of a multi-line value, the
    // arrows move between rows instead (handled by leaving them to the terminal
    // — value is single visual line in practice, so this is effectively always
    // top+bottom). "Top row" = no newline before the cursor; "bottom row" = no
    // newline after it.
    if (key.upArrow) {
      const atTopRow = !value.slice(0, cursor).includes('\n')
      if (atTopRow) recallPrev()
      else setCursor(cursor - 1) // move up a row: step before the preceding newline boundary
      return
    }
    if (key.downArrow) {
      const atBottomRow = !value.slice(cursor).includes('\n')
      if (atBottomRow) recallNext()
      else setCursor(cursor + 1)
      return
    }

    if (key.ctrl && input === 'a') { setCursor(0); return }
    if (key.ctrl && input === 'e') { setCursor(value.length); return }
    if (key.ctrl && input === 'u') {
      setHistIdx(null)
      onChange?.(value.slice(cursor))
      setCursor(0)
      return
    }
    if (key.ctrl && input === 'k') {
      setHistIdx(null)
      onChange?.(value.slice(0, cursor))
      return
    }
    if (key.ctrl && input === 'w') {
      setHistIdx(null)
      const start = prevWordBoundary(value, cursor)
      onChange?.(value.slice(0, start) + value.slice(cursor))
      setCursor(start)
      return
    }

    // Ink quirk: terminals send 0x7f (DEL) when the user presses Backspace,
    // and Ink reports that as `key.delete` while reserving `key.backspace`
    // for Ctrl+H (0x08). Treat both as "delete char to the left of cursor"
    // so the key behaves the way every other shell behaves. Forward-delete
    // (Fn+Delete on macOS) is shadowed by this, which is the right trade-off
    // for a chat input — almost nobody uses forward-delete here.
    if (key.backspace || key.delete) {
      if (cursor === 0) return
      setHistIdx(null)
      if (key.meta) {
        const start = prevWordBoundary(value, cursor)
        onChange?.(value.slice(0, start) + value.slice(cursor))
        setCursor(start)
      } else {
        onChange?.(value.slice(0, cursor - 1) + value.slice(cursor))
        setCursor(cursor - 1)
      }
      return
    }

    // Drop other control sequences silently.
    if (key.ctrl) return
    if (!input) return
    // Strip stray escape-prefixed sequences (option+letter on some terms),
    // but allow regular printable text — including drag-and-drop pastes,
    // which may include backslash-escaped spaces. We accept multi-char input
    // because terminals deliver paste events as a single chunk.
    if (input.charCodeAt(0) === 0x1b) return

    setHistIdx(null)
    onChange?.(value.slice(0, cursor) + input + value.slice(cursor))
    setCursor(cursor + input.length)
  })

  return h(Box, { flexDirection: 'column' },
    suggestions.length > 0 ? h(Box, {
      flexDirection: 'column', borderStyle: 'round', borderColor: c.accentDim, paddingX: 1, marginBottom: 0,
    },
      ...suggestions
        .slice(suggestionWindowStart, suggestionWindowStart + MAX_VISIBLE_SUGGESTIONS)
        .map((s, i) => {
          const idx = suggestionWindowStart + i
          const selected = idx === suggestionIdx
          return h(Box, { key: s.cmd },
            h(Text, { color: selected ? c.accent : c.muted, bold: selected },
              `${selected ? '❯ ' : '  '}${s.cmd.padEnd(12)}`
            ),
            h(Text, { color: c.dim }, s.desc)
          )
        }),
      h(Box, { marginTop: 0 },
        h(Text, { color: c.dim },
          suggestions.length > MAX_VISIBLE_SUGGESTIONS
            ? `[enter] run  [tab] complete  [↑↓] navigate  [esc] dismiss  (${suggestionIdx + 1}/${suggestions.length})`
            : '[enter] run  [tab] complete  [↑↓] navigate  [esc] dismiss'
        )
      )
    ) : null,
    h(Box, { borderStyle: 'round', borderColor: isStreaming ? c.warn : c.accent, paddingX: 1 },
      h(Text, { color: isStreaming ? c.warn : c.accent, bold: true }, isStreaming ? '⋯ ' : '❯ '),
      renderEditor(value, cursor, placeholder, c),
      queuedCount > 0 ? h(Text, { color: c.warn, dimColor: true }, `  (${queuedCount} queued)`) : null
    )
  )
}

function renderEditor(value, cursor, placeholder, c) {
  if (!value) {
    return h(Box, null,
      h(Text, { inverse: true }, ' '),
      h(Text, { color: c.dim }, placeholder)
    )
  }
  const safeCursor = Math.max(0, Math.min(cursor, value.length))
  const before = value.slice(0, safeCursor)
  const at = value.slice(safeCursor, safeCursor + 1) || ' '
  const after = value.slice(safeCursor + 1)
  return h(Box, null,
    before ? h(Text, null, before) : null,
    h(Text, { inverse: true }, at),
    after ? h(Text, null, after) : null
  )
}
