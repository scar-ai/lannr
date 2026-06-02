// Overlay shown by the `/model` slash command. Lists every model available
// across configured providers so the user can switch with arrow keys + enter.
// Esc dismisses. On select, the parent applies the model (and its provider) as
// an override for subsequent turns.

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

const h = React.createElement

const VISIBLE_ROWS = 10

export function ModelsMenu({ models, currentModelId, currentProviderId, onSelect, onCancel }) {
  const [index, setIndex] = useState(() => {
    const idx = models.findIndex((m) => m.id === currentModelId && m.provider === currentProviderId)
    if (idx >= 0) return idx
    const byId = models.findIndex((m) => m.id === currentModelId)
    return byId >= 0 ? byId : 0
  })

  useInput((_input, key) => {
    if (key.escape) { onCancel?.(); return }
    if (key.upArrow) {
      setIndex((i) => (i - 1 + models.length) % models.length)
      return
    }
    if (key.downArrow) {
      setIndex((i) => (i + 1) % models.length)
      return
    }
    if (key.return) {
      const picked = models[index]
      if (picked) onSelect?.(picked)
      return
    }
  })

  if (models.length === 0) {
    return h(Box, {
      flexDirection: 'column',
      marginY: 1,
      paddingX: 2,
      borderStyle: 'round',
      borderColor: 'cyan',
      alignSelf: 'center',
    },
      h(Text, { color: 'cyan', bold: true }, 'Models'),
      h(Box, { marginTop: 1 },
        h(Text, { color: 'gray' }, 'No models configured.')
      ),
      h(Box, { marginTop: 1 },
        h(Text, { color: 'gray', dimColor: true }, 'esc dismiss')
      )
    )
  }

  const half = Math.floor(VISIBLE_ROWS / 2)
  let start = Math.max(0, index - half)
  const end = Math.min(models.length, start + VISIBLE_ROWS)
  start = Math.max(0, end - VISIBLE_ROWS)
  const window = models.slice(start, end)

  const idWidth = Math.min(28, Math.max(...models.map((m) => m.id.length)))

  return h(Box, { flexDirection: 'column', alignItems: 'center', marginY: 1 },
    h(Box, {
      flexDirection: 'column',
      paddingX: 2,
      paddingY: 1,
      borderStyle: 'round',
      borderColor: 'cyan',
    },
      h(Box, null,
        h(Text, { color: 'cyan', bold: true }, 'Models  '),
        h(Text, { color: 'gray', dimColor: true }, `(${models.length} total)`)
      ),
      h(Box, { flexDirection: 'column', marginTop: 1 },
        ...window.map((m, i) => {
          const realIdx = start + i
          const active = realIdx === index
          const isCurrent = m.id === currentModelId && m.provider === currentProviderId
          return h(Box, { key: `${m.provider}:${m.id}` },
            h(Text, { color: active ? 'cyan' : 'gray' }, active ? '❯ ' : '  '),
            h(Text, { color: active ? 'white' : 'gray', bold: active }, m.id.padEnd(idWidth)),
            h(Text, { color: 'gray', dimColor: true }, '  '),
            h(Text, { color: active ? 'white' : 'gray', wrap: 'truncate-end' }, m.provider),
            m.isDefault ? h(Text, { color: 'gray', dimColor: true }, '  (default)') : null,
            isCurrent ? h(Text, { color: 'green', dimColor: true }, '  (current)') : null,
          )
        })
      ),
      h(Box, { marginTop: 1 },
        h(Text, { color: 'gray', dimColor: true }, '↑↓ navigate  ↵ switch  esc cancel')
      )
    )
  )
}
