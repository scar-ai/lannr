// Unified rate-limit header parsing across provider families. Each provider
// uses its own header dialect:
//   • OpenAI / Codex / OpenAI-compatible: `x-ratelimit-{limit,remaining,reset}-{requests,tokens}[-1h]`
//     (12 headers, modeled on the convention hermes_agent parses)
//   • Anthropic: `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`
//     (reset is an RFC 3339 timestamp, NOT seconds — gotcha)
//   • Google Gemini: no rate headers on success; quota errors carry body-level info only
//
// Returns a normalized RateLimitState the gateway can ship to the UI and the
// retry path can use to pick a smarter backoff than a static 10-second guess.

const NOW = () => Date.now()

// ── Public API ────────────────────────────────────────────────────────────────

export function parseRateLimitHeaders(headers, providerType) {
  const lowered = lowerHeaders(headers)
  if (!lowered) return null
  const family = familyFor(providerType)
  if (family === 'anthropic') return parseAnthropic(lowered)
  if (family === 'openai') return parseOpenAI(lowered)
  return null
}

// Returns milliseconds the caller should wait before retrying, derived from
// response headers. Honors:
//   • `retry-after`            (seconds OR HTTP-date — generic)
//   • `x-ratelimit-reset-*`    (seconds remaining — OpenAI convention)
//   • `anthropic-ratelimit-*-reset` (RFC 3339 timestamp — Anthropic)
// Returns null when no usable signal is present (caller falls back to its
// exponential backoff default).
export function retryAfterMsFromHeaders(headers, providerType) {
  const lowered = lowerHeaders(headers)
  if (!lowered) return null

  // Generic Retry-After (RFC 7231 §7.1.3) — wins when present.
  const retryAfter = lowered['retry-after']
  if (retryAfter) {
    const asNumber = Number(retryAfter)
    if (Number.isFinite(asNumber) && asNumber > 0) return Math.round(asNumber * 1000)
    const asDate = Date.parse(retryAfter)
    if (Number.isFinite(asDate)) return Math.max(0, asDate - NOW())
  }

  const family = familyFor(providerType)
  if (family === 'anthropic') {
    // Anthropic returns ISO timestamps. Pick the soonest reset across buckets.
    const candidates = [
      lowered['anthropic-ratelimit-requests-reset'],
      lowered['anthropic-ratelimit-tokens-reset'],
      lowered['anthropic-ratelimit-input-tokens-reset'],
      lowered['anthropic-ratelimit-output-tokens-reset'],
    ]
      .map((iso) => (iso ? Date.parse(iso) : NaN))
      .filter((ts) => Number.isFinite(ts) && ts > NOW())
    if (candidates.length) return Math.max(0, Math.min(...candidates) - NOW())
  }

  if (family === 'openai') {
    // OpenAI returns seconds (sometimes as "12.345s" — strip the trailing s).
    const candidates = [
      lowered['x-ratelimit-reset-requests'],
      lowered['x-ratelimit-reset-tokens'],
    ]
      .map(parseOpenAIResetSeconds)
      .filter((ms) => ms != null && ms > 0)
    if (candidates.length) return Math.min(...candidates)
  }

  return null
}

// One-line summary for the chat footer. Returns null when state is empty.
export function formatRateStateCompact(state) {
  if (!state) return null
  const parts = []
  if (state.requestsRemaining != null && state.requestsLimit) {
    parts.push(`rpm ${state.requestsRemaining}/${state.requestsLimit}`)
  } else if (state.requestsRemaining != null) {
    parts.push(`req-left ${state.requestsRemaining}`)
  }
  if (state.tokensRemaining != null && state.tokensLimit) {
    parts.push(`tpm ${shortNum(state.tokensRemaining)}/${shortNum(state.tokensLimit)}`)
  } else if (state.tokensRemaining != null) {
    parts.push(`tok-left ${shortNum(state.tokensRemaining)}`)
  }
  if (state.resetSeconds != null) {
    parts.push(`reset ${shortDur(state.resetSeconds)}`)
  }
  return parts.length ? parts.join(' · ') : null
}

// ── Parsing internals ─────────────────────────────────────────────────────────

function familyFor(providerType) {
  const t = String(providerType ?? '').toLowerCase()
  if (['anthropic', 'anthropic-messages', 'anthropic-compatible'].includes(t)) return 'anthropic'
  if (['google', 'gemini', 'google-gemini'].includes(t)) return 'google'
  return 'openai'
}

function lowerHeaders(headers) {
  if (!headers) return null
  // Native fetch Headers
  if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
    const out = {}
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value
    })
    return out
  }
  if (typeof headers === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(headers)) out[String(k).toLowerCase()] = v
    return out
  }
  return null
}

function parseOpenAI(h) {
  const hasAny = Object.keys(h).some((k) => k.startsWith('x-ratelimit-'))
  if (!hasAny) return null
  const requestsLimit = numOr(h['x-ratelimit-limit-requests'], null)
  const requestsRemaining = numOr(h['x-ratelimit-remaining-requests'], null)
  const tokensLimit = numOr(h['x-ratelimit-limit-tokens'], null)
  const tokensRemaining = numOr(h['x-ratelimit-remaining-tokens'], null)
  const resetReqMs = parseOpenAIResetSeconds(h['x-ratelimit-reset-requests'])
  const resetTokMs = parseOpenAIResetSeconds(h['x-ratelimit-reset-tokens'])
  const resetMs = soonest([resetReqMs, resetTokMs])
  return {
    provider: 'openai',
    requestsLimit,
    requestsRemaining,
    tokensLimit,
    tokensRemaining,
    resetSeconds: resetMs == null ? null : Math.round(resetMs / 1000),
    capturedAt: NOW(),
    raw: h,
  }
}

function parseAnthropic(h) {
  const hasAny = Object.keys(h).some((k) => k.startsWith('anthropic-ratelimit-'))
  if (!hasAny) return null
  const requestsLimit = numOr(h['anthropic-ratelimit-requests-limit'], null)
  const requestsRemaining = numOr(h['anthropic-ratelimit-requests-remaining'], null)
  // Prefer the unified `tokens` bucket; fall back to input-tokens for newer
  // models that split input/output.
  const tokensLimit =
    numOr(h['anthropic-ratelimit-tokens-limit'], null)
    ?? numOr(h['anthropic-ratelimit-input-tokens-limit'], null)
  const tokensRemaining =
    numOr(h['anthropic-ratelimit-tokens-remaining'], null)
    ?? numOr(h['anthropic-ratelimit-input-tokens-remaining'], null)
  // Reset is an ISO timestamp; convert to seconds-from-now.
  const resetMs = soonest([
    isoToMsFromNow(h['anthropic-ratelimit-requests-reset']),
    isoToMsFromNow(h['anthropic-ratelimit-tokens-reset']),
    isoToMsFromNow(h['anthropic-ratelimit-input-tokens-reset']),
    isoToMsFromNow(h['anthropic-ratelimit-output-tokens-reset']),
  ])
  return {
    provider: 'anthropic',
    requestsLimit,
    requestsRemaining,
    tokensLimit,
    tokensRemaining,
    resetSeconds: resetMs == null ? null : Math.round(resetMs / 1000),
    capturedAt: NOW(),
    raw: h,
  }
}

// ── Coercion helpers ──────────────────────────────────────────────────────────

function numOr(value, fallback) {
  if (value == null) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function parseOpenAIResetSeconds(value) {
  if (value == null) return null
  // OpenAI sometimes returns "12.5s" or "1.123ms" — handle both.
  const str = String(value).trim()
  const msMatch = /^([\d.]+)ms$/i.exec(str)
  if (msMatch) return Math.round(Number(msMatch[1]))
  const sMatch = /^([\d.]+)s?$/i.exec(str)
  if (sMatch) return Math.round(Number(sMatch[1]) * 1000)
  return null
}

function isoToMsFromNow(value) {
  if (!value) return null
  const ts = Date.parse(value)
  if (!Number.isFinite(ts)) return null
  return Math.max(0, ts - NOW())
}

function soonest(values) {
  const positive = values.filter((v) => v != null && v >= 0)
  return positive.length ? Math.min(...positive) : null
}

function shortNum(n) {
  if (n == null) return '?'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function shortDur(seconds) {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}
