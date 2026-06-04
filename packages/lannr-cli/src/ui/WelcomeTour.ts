import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from './theme.js'

const h = React.createElement

// Each slide carries a decorative accent name; resolve it against the active
// palette so the tour follows the user's chosen theme.
function tone(name, c) {
  switch (name) {
    case 'magenta': return c.assistant
    case 'green': return c.success
    case 'yellow': return c.warn
    case 'blue': return c.accentDim
    case 'red': return c.error
    case 'cyan': return c.accent
    default: return c.accent
  }
}

const SLIDES = [
  {
    icon: '✦',
    color: 'magenta',
    title: 'Welcome to Lannr',
    lines: [
      'Your local agentic toolkit is ready.',
      'Take a minute — here is what you can build.',
    ],
    hint: 'press ↵ or → to continue, ← to go back',
  },
  {
    icon: '◉',
    color: 'green',
    title: 'Computer use',
    lines: [
      'Agents can drive a real browser and your desktop.',
      'Click, type, screenshot and scrape without leaving the chat.',
      'Falls back to local Chromium when no remote runner is wired.',
    ],
    hint: 'lannr agents add --capability computer-use',
  },
  {
    icon: '⏱',
    color: 'yellow',
    title: 'Scheduled & recurring routines',
    lines: [
      'Cron-style triggers fire agents on a schedule or external events.',
      'Routines are stored locally and replayed by the scheduler.',
      'The gateway must be running for recurrent calls to execute.',
    ],
    hint: 'lannr gateway up   •   lannr routine add',
  },
  {
    icon: '⇄',
    color: 'blue',
    title: 'Gateway API',
    lines: [
      'A local HTTP gateway exposes /chat, /run, /events and webhooks.',
      'Wire Lannr into apps, Slack, n8n or your own UI.',
      'Same auth and rate limits as the CLI — one source of truth.',
    ],
    hint: 'lannr gateway up --port 4242',
  },
  {
    icon: '⌘',
    color: 'red',
    title: 'Multi-agent',
    lines: [
      'Compose specialised agents and let them hand off tasks.',
      'Each agent has its own workspace, memory and provider.',
      'Switch with `/agent` inside chat or spawn them in parallel.',
    ],
    hint: 'lannr agents add   •   /agent inside chat',
  },
  {
    icon: '⌬',
    color: 'magenta',
    title: 'MCP servers',
    lines: [
      'Plug any Model Context Protocol server into Lannr.',
      'Tools, resources and prompts from MCP appear natively to the agent.',
      'Local stdio or remote servers — both supported.',
    ],
    hint: 'lannr mcp add',
  },
  {
    icon: '✓',
    color: 'green',
    title: "You're ready",
    lines: [
      'Dropping you into a chat with your new agent.',
      'Type `/help` any time to see what is available.',
    ],
    hint: 'press ↵ to enter chat',
  },
]

const FRAME_MS = 70
const TYPE_CHARS_PER_FRAME = 1.4
const AUTO_ADVANCE_MS = 10000

export function WelcomeTour({ onDone }) {
  const [index, setIndex] = useState(0)
  const [tick, setTick] = useState(0)
  const [paused, setPaused] = useState(false)
  const [doneFiring, setDoneFiring] = useState(false)
  const indexRef = useRef(0)
  indexRef.current = index

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), FRAME_MS)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    setTick(0)
  }, [index])

  const slide = SLIDES[index]
  const totalChars = slide.lines.join(' ').length
  const charsRevealed = Math.min(totalChars, Math.floor(tick * TYPE_CHARS_PER_FRAME))
  const typingDone = charsRevealed >= totalChars
  const typingFinishedAt = useRef(0)
  if (typingDone && typingFinishedAt.current === 0) typingFinishedAt.current = tick
  if (!typingDone) typingFinishedAt.current = 0
  const elapsedSinceTyped = typingDone ? (tick - typingFinishedAt.current) * FRAME_MS : 0

  // Auto-advance only after typing is done AND user hasn't paused
  useEffect(() => {
    if (paused || !typingDone) return
    if (elapsedSinceTyped < AUTO_ADVANCE_MS) return
    handleAdvance(1)
  }, [tick, paused, typingDone, elapsedSinceTyped])

  useEffect(() => {
    if (!doneFiring) return
    onDone?.()
  }, [doneFiring])

  function handleAdvance(delta) {
    const current = indexRef.current
    const next = current + delta
    if (next >= SLIDES.length) {
      setDoneFiring(true)
      return
    }
    if (next < 0) return
    typingFinishedAt.current = 0
    setIndex(next)
  }

  function skipTypewriter() {
    typingFinishedAt.current = tick
    setTick((t) => t + Math.ceil(totalChars / TYPE_CHARS_PER_FRAME))
  }

  useInput((inputChar, key) => {
    if (key.rightArrow || key.return || inputChar === ' ') {
      if (!typingDone) skipTypewriter()
      else handleAdvance(1)
    } else if (key.leftArrow) {
      handleAdvance(-1)
    } else if (key.escape || inputChar === 'q') {
      setDoneFiring(true)
    } else if (inputChar === 'p') {
      setPaused((p) => !p)
    } else {
      // Any other key reveals the rest of the slide for impatient readers
      if (!typingDone) skipTypewriter()
    }
  })

  const remainingMs = Math.max(0, AUTO_ADVANCE_MS - elapsedSinceTyped)
  const cursorOn = Math.floor(tick / 6) % 2 === 0
  const c = theme()
  const slideTone = tone(slide.color, c)

  return h(Box, { flexDirection: 'column', paddingX: 1, paddingY: 1 },
    h(Box, { marginBottom: 1, justifyContent: 'space-between' },
      h(Box, null,
        h(Text, { color: c.muted }, `step ${index + 1} of ${SLIDES.length}  `),
        h(Text, { color: c.accent }, renderProgress(index, SLIDES.length)),
      ),
      h(Text, { color: paused ? c.warn : c.dim, dimColor: !paused },
        paused ? '⏸ paused' : typingDone ? `▶ auto-advance in ${Math.ceil(remainingMs / 1000)}s` : '▶ typing…',
      ),
    ),
    h(Box, { borderStyle: 'round', borderColor: slideTone, paddingX: 2, paddingY: 1, flexDirection: 'column' },
      h(Box, null,
        h(Text, { color: slideTone, bold: true }, `${slide.icon}  ${slide.title}`),
      ),
      h(Box, { marginTop: 1, flexDirection: 'column' },
        ...renderTypedLines(slide.lines, charsRevealed, !typingDone && cursorOn),
      ),
      slide.hint
        ? h(Box, { marginTop: 1 },
            h(Text, { color: c.dim, dimColor: true }, `↳ ${slide.hint}`))
        : null,
    ),
    h(Box, { marginTop: 1, paddingX: 1, justifyContent: 'space-between' },
      h(Text, { color: c.dim, dimColor: true },
        '←  prev    →/↵/space  next    any key  reveal    p  pause    esc  skip'),
    ),
  )
}

function renderProgress(index, total) {
  let out = ''
  for (let i = 0; i < total; i++) {
    if (i < index) out += '●'
    else if (i === index) out += '◉'
    else out += '○'
    if (i < total - 1) out += ' '
  }
  return out
}

function renderTypedLines(lines, charsRevealed, showCursor) {
  const c = theme()
  const nodes = []
  let remaining = charsRevealed
  for (let i = 0; i < lines.length; i++) {
    const full = lines[i]
    const visible = remaining <= 0 ? '' : full.slice(0, remaining)
    remaining = Math.max(0, remaining - full.length - 1)
    const isCurrentlyTyping = visible.length > 0 && visible.length < full.length
    nodes.push(
      h(Box, { key: i },
        h(Text, { color: c.text }, visible || ' '),
        showCursor && isCurrentlyTyping ? h(Text, { color: c.accent }, '▏') : null,
      ),
    )
  }
  return nodes
}
