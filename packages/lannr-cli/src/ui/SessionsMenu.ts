// Overlay shown by the `/sessions` slash command. Lists every saved session
// for the active agent so the user can resume one with arrow keys + enter.
// Esc dismisses. The current session is saved before switching (handled by
// the parent ChatApp).

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from './theme.js'

const h = React.createElement

const VISIBLE_ROWS = 10

function formatRelativeTime(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 0) return 'just now'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const hr = Math.floor(m / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 30) return `${d}d ago`
  return new Date(t).toISOString().slice(0, 10)
}

export function SessionsMenu({ sessions, currentSessionId, onSelect, onCancel }) {
  const c = theme()
  const [index, setIndex] = useState(() => {
    const idx = sessions.findIndex((s) => s.id === currentSessionId)
    return idx >= 0 ? idx : 0
  })

  useInput((_input, key) => {
    if (key.escape) { onCancel?.(); return }
    if (key.upArrow) {
      setIndex((i) => (i - 1 + sessions.length) % sessions.length)
      return
    }
    if (key.downArrow) {
      setIndex((i) => (i + 1) % sessions.length)
      return
    }
    if (key.return) {
      const picked = sessions[index]
      if (picked) onSelect?.(picked)
      return
    }
  })

  if (sessions.length === 0) {
    return h(Box, {
      flexDirection: 'column',
      marginY: 1,
      paddingX: 2,
      borderStyle: 'round',
      borderColor: c.accentDim,
      alignSelf: 'center',
    },
      h(Text, { color: c.accent, bold: true }, 'Sessions'),
      h(Box, { marginTop: 1 },
        h(Text, { color: c.muted }, 'No saved sessions for this agent yet.')
      ),
      h(Box, { marginTop: 1 },
        h(Text, { color: c.dim, dimColor: true }, 'esc dismiss')
      )
    )
  }

  // Windowed scroll so very long lists stay readable.
  const half = Math.floor(VISIBLE_ROWS / 2)
  let start = Math.max(0, index - half)
  const end = Math.min(sessions.length, start + VISIBLE_ROWS)
  start = Math.max(0, end - VISIBLE_ROWS)
  const window = sessions.slice(start, end)

  return h(Box, { flexDirection: 'column', alignItems: 'center', marginY: 1 },
    h(Box, {
      flexDirection: 'column',
      paddingX: 2,
      paddingY: 1,
      borderStyle: 'round',
      borderColor: c.accentDim,
    },
      h(Box, null,
        h(Text, { color: c.accent, bold: true }, 'Sessions  '),
        h(Text, { color: c.dim, dimColor: true }, `(${sessions.length} total)`)
      ),
      h(Box, { flexDirection: 'column', marginTop: 1 },
        ...window.map((s, i) => {
          const realIdx = start + i
          const active = realIdx === index
          const isCurrent = s.id === currentSessionId
          return h(Box, { key: s.id },
            h(Text, { color: active ? c.accent : c.muted }, active ? '❯ ' : '  '),
            h(Text, { color: active ? c.text : c.muted, bold: active }, s.id.padEnd(14)),
            h(Text, { color: c.dim, dimColor: true }, '  '),
            h(Text, { color: active ? c.text : c.muted, wrap: 'truncate-end' }, s.title),
            isCurrent ? h(Text, { color: c.success, dimColor: true }, '  (current)') : null,
            s.updatedAt ? h(Text, { color: c.dim, dimColor: true }, `  · ${formatRelativeTime(s.updatedAt)}`) : null,
          )
        })
      ),
      h(Box, { marginTop: 1 },
        h(Text, { color: c.dim, dimColor: true }, '↑↓ navigate  ↵ resume  esc cancel')
      )
    )
  )
}
