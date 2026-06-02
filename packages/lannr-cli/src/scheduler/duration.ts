const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
const UNIT_ALIASES = {
  s: 's', sec: 's', secs: 's', second: 's', seconds: 's',
  m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm',
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  d: 'd', day: 'd', days: 'd',
}

export function parseDurationMs(value) {
  if (value == null) throw new Error('Duration is required')
  const cleaned = String(value).trim().toLowerCase()
    .replace(/^in\s+/, '')
    .replace(/^every\s+/, '')
    .replace(/^after\s+/, '')
  if (!cleaned) throw new Error(`Invalid duration: ${value}`)
  if (/^\d+(\.\d+)?$/.test(cleaned)) {
    return Math.round(Number(cleaned) * UNIT_MS.m)
  }
  const pattern = /(\d+(?:\.\d+)?)\s*([a-z]+)/g
  let total = 0
  let matched = false
  let cursor = 0
  for (const match of cleaned.matchAll(pattern)) {
    matched = true
    if (match.index !== cursor) throw new Error(`Invalid duration: ${value}`)
    const unit = UNIT_ALIASES[match[2]]
    if (!unit) throw new Error(`Unknown duration unit "${match[2]}" in: ${value}`)
    total += Number(match[1]) * UNIT_MS[unit]
    cursor = match.index + match[0].length
    while (cursor < cleaned.length && /\s/.test(cleaned[cursor])) cursor++
  }
  if (!matched || cursor !== cleaned.length) throw new Error(`Invalid duration: ${value}`)
  if (total <= 0) throw new Error(`Duration must be positive: ${value}`)
  return Math.round(total)
}

export function parseRunAt(value, now = new Date()) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) {
    throw new Error(`runAt must be an ISO timestamp or parseable date string: ${value}`)
  }
  if (date.getTime() <= now.getTime()) throw new Error(`runAt must be in the future: ${value}`)
  return date
}

export function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const parts = []
  let remaining = ms
  for (const unit of ['d', 'h', 'm', 's']) {
    const size = UNIT_MS[unit]
    const whole = Math.floor(remaining / size)
    if (whole > 0) {
      parts.push(`${whole}${unit}`)
      remaining -= whole * size
    }
  }
  return parts.length ? parts.join('') : `${ms}ms`
}

export function normalizeTriggerInput(input, { now = new Date() } = {}) {
  const provided = ['runAt', 'in', 'every', 'cron'].filter((key) => input[key] != null && input[key] !== '')
  if (provided.length === 0) throw new Error('Provide one of runAt, in, every, or cron')
  if (provided.length > 1) throw new Error(`Provide exactly one trigger; got: ${provided.join(', ')}`)

  if (input.runAt != null) {
    const runAt = parseRunAt(input.runAt, now)
    return { trigger: { type: 'once', runAt: runAt.toISOString() }, nextRunAt: runAt }
  }
  if (input.in != null) {
    const runAt = new Date(now.getTime() + parseDurationMs(input.in))
    return { trigger: { type: 'once', runAt: runAt.toISOString() }, nextRunAt: runAt }
  }
  if (input.every != null) {
    const intervalMs = parseDurationMs(input.every)
    const nextRunAt = new Date(now.getTime() + intervalMs)
    return { trigger: { type: 'interval', intervalMs }, nextRunAt }
  }
  return { trigger: { type: 'cron', cron: String(input.cron) }, nextRunAt: null }
}
