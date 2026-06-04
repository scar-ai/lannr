// Overlay shown by the `/agent` slash command. Lists every configured agent
// with its description so the user can switch with arrow keys + enter. Esc
// dismisses. On select, the parent resumes that agent's last session (or
// creates a new one if none exists).

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from './theme.js'

const h = React.createElement

const VISIBLE_ROWS = 10

export function AgentsMenu({ agents, currentAgentId, onSelect, onCancel }) {
  const c = theme()
  const [index, setIndex] = useState(() => {
    const idx = agents.findIndex((a) => a.id === currentAgentId)
    return idx >= 0 ? idx : 0
  })

  useInput((_input, key) => {
    if (key.escape) { onCancel?.(); return }
    if (key.upArrow) {
      setIndex((i) => (i - 1 + agents.length) % agents.length)
      return
    }
    if (key.downArrow) {
      setIndex((i) => (i + 1) % agents.length)
      return
    }
    if (key.return) {
      const picked = agents[index]
      if (picked) onSelect?.(picked)
      return
    }
  })

  if (agents.length === 0) {
    return h(Box, {
      flexDirection: 'column',
      marginY: 1,
      paddingX: 2,
      borderStyle: 'round',
      borderColor: c.accentDim,
      alignSelf: 'center',
    },
      h(Text, { color: c.accent, bold: true }, 'Agents'),
      h(Box, { marginTop: 1 },
        h(Text, { color: c.muted }, 'No agents configured.')
      ),
      h(Box, { marginTop: 1 },
        h(Text, { color: c.dim, dimColor: true }, 'esc dismiss')
      )
    )
  }

  const half = Math.floor(VISIBLE_ROWS / 2)
  let start = Math.max(0, index - half)
  const end = Math.min(agents.length, start + VISIBLE_ROWS)
  start = Math.max(0, end - VISIBLE_ROWS)
  const window = agents.slice(start, end)

  const idWidth = Math.min(20, Math.max(...agents.map((a) => a.id.length)))

  return h(Box, { flexDirection: 'column', alignItems: 'center', marginY: 1 },
    h(Box, {
      flexDirection: 'column',
      paddingX: 2,
      paddingY: 1,
      borderStyle: 'round',
      borderColor: c.accentDim,
    },
      h(Box, null,
        h(Text, { color: c.accent, bold: true }, 'Agents  '),
        h(Text, { color: c.dim, dimColor: true }, `(${agents.length} total)`)
      ),
      h(Box, { flexDirection: 'column', marginTop: 1 },
        ...window.map((a, i) => {
          const realIdx = start + i
          const active = realIdx === index
          const isCurrent = a.id === currentAgentId
          const description = (a.description || '').trim()
          return h(Box, { key: a.id },
            h(Text, { color: active ? c.accent : c.muted }, active ? '❯ ' : '  '),
            h(Text, { color: active ? c.text : c.muted, bold: active }, a.id.padEnd(idWidth)),
            h(Text, { color: c.dim, dimColor: true }, '  '),
            h(Text, { color: active ? c.text : c.muted, wrap: 'truncate-end' },
              description || a.name || ''),
            isCurrent ? h(Text, { color: c.success, dimColor: true }, '  (current)') : null,
          )
        })
      ),
      h(Box, { marginTop: 1 },
        h(Text, { color: c.dim, dimColor: true }, '↑↓ navigate  ↵ switch  esc cancel')
      )
    )
  )
}
