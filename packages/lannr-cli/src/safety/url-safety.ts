import { lookup } from 'node:dns/promises'

const ALWAYS_BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
])

const ALWAYS_BLOCKED_IPS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '169.254.169.253',
  '100.100.100.200',
  'fd00:ec2::254',
])

let cachedPolicy = null

export function setUrlSafetyPolicy(policy) {
  cachedPolicy = policy
    ? {
        allowPrivate: Boolean(policy.allowPrivate),
        denyHosts: new Set((policy.denyHosts ?? []).map((entry) => normalizeHost(entry)).filter(Boolean)),
        allowHosts: new Set((policy.allowHosts ?? []).map((entry) => normalizeHost(entry)).filter(Boolean)),
      }
    : null
}

export function getUrlSafetyPolicy() {
  if (cachedPolicy) return cachedPolicy
  const allowPrivate = /^(1|true|yes)$/i.test(String(process.env.LANNR_ALLOW_PRIVATE_URLS ?? ''))
  cachedPolicy = {
    allowPrivate,
    denyHosts: new Set(splitEnvList(process.env.LANNR_URL_DENYLIST).map(normalizeHost).filter(Boolean)),
    allowHosts: new Set(splitEnvList(process.env.LANNR_URL_ALLOWLIST).map(normalizeHost).filter(Boolean)),
  }
  return cachedPolicy
}

export class UrlSafetyError extends Error {
  [key: string]: any

  constructor(message, { code, hostname }: Record<string, any> = {}) {
    super(message)
    this.name = 'UrlSafetyError'
    this.code = code ?? 'url_unsafe'
    this.hostname = hostname
  }
}

export async function assertSafeUrl(value, { allowPrivate }: Record<string, any> = {}) {
  const url = parseUrl(value)
  const hostname = normalizeHost(url.hostname)
  if (!hostname) throw new UrlSafetyError('URL has no hostname', { code: 'url_no_host' })
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new UrlSafetyError(`Refusing non-http(s) URL: ${url.protocol}`, { code: 'url_bad_scheme', hostname })
  }
  if (ALWAYS_BLOCKED_HOSTNAMES.has(hostname)) {
    throw new UrlSafetyError(`Refusing cloud-metadata hostname: ${hostname}`, { code: 'url_metadata_host', hostname })
  }
  const policy = getUrlSafetyPolicy()
  if (policy.denyHosts.size && matchesHostList(hostname, policy.denyHosts)) {
    throw new UrlSafetyError(`Host blocked by policy: ${hostname}`, { code: 'url_denylist', hostname })
  }
  const allowed = policy.allowHosts.size > 0 && matchesHostList(hostname, policy.allowHosts)
  const effectiveAllowPrivate = allowPrivate ?? policy.allowPrivate

  const records = await lookup(url.hostname, { all: true, verbatim: true }).catch(() => [])
  if (!records.length) throw new UrlSafetyError(`Could not resolve host: ${url.hostname}`, { code: 'url_no_dns', hostname })

  for (const record of records) {
    if (ALWAYS_BLOCKED_IPS.has(record.address)) {
      throw new UrlSafetyError(`Refusing cloud-metadata IP: ${record.address}`, { code: 'url_metadata_ip', hostname })
    }
    if (!effectiveAllowPrivate && !allowed && isPrivateAddress(record.address)) {
      throw new UrlSafetyError(`Refusing private/internal address ${record.address} (${hostname})`, {
        code: 'url_private_ip',
        hostname,
      })
    }
  }
  return url
}

export async function isSafeUrl(value, options) {
  try {
    await assertSafeUrl(value, options)
    return true
  } catch {
    return false
  }
}

function parseUrl(value) {
  try {
    return new URL(String(value ?? '').trim())
  } catch {
    throw new UrlSafetyError(`Invalid URL: ${value}`, { code: 'url_parse' })
  }
}

function normalizeHost(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.$/, '')
}

function matchesHostList(hostname, set) {
  if (set.has(hostname)) return true
  for (const entry of set) {
    if (entry.startsWith('*.') && hostname.endsWith(entry.slice(1))) return true
    if (hostname.endsWith(`.${entry}`)) return true
  }
  return false
}

function splitEnvList(value) {
  if (!value) return []
  return String(value).split(/[,\s]+/).filter(Boolean)
}

function isPrivateAddress(address) {
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true
  if (address.includes(':')) {
    const lower = address.toLowerCase()
    return (
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80:') ||
      lower === '::'
    )
  }
  const parts = address.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true
  const [a, b] = parts
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  // CGNAT 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true
  // Benchmark 198.18.0.0/15
  if (a === 198 && (b === 18 || b === 19)) return true
  return false
}
