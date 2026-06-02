import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const OPENAI_AUTH_BASE_URL = 'https://auth.openai.com'
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_CODEX_DEVICE_CALLBACK_URL = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`
const DEVICE_CODE_TIMEOUT_MS = 15 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 5_000

interface OpenAICodexAuthOptions {
  root?: string
}

export function openAICodexAuthPath({ root }: OpenAICodexAuthOptions = {}) {
  return join(resolve(root ?? homedir()), '.lannr', 'openai-codex-auth.json')
}

export async function removeOpenAICodexAuth(options: OpenAICodexAuthOptions = {}) {
  await rm(openAICodexAuthPath(options), { force: true })
}

export async function readOpenAICodexAccessToken() {
  const auth = await readOpenAICodexAuth()
  const token = auth?.tokens?.access_token ?? auth?.access
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('OpenAI Codex auth is not ready. Run `lannr provider login openai-codex`.')
  }
  return token
}

export async function loginOpenAICodex({ openBrowser = true, log = console.log } = {}) {
  log('Starting OpenAI Codex ChatGPT login...')
  const device = await requestDeviceCode()
  log(`Open this URL to sign in with ChatGPT: ${device.verificationUrl}`)
  log(`Enter code: ${device.userCode}`)
  if (openBrowser) await openUrl(device.verificationUrl)

  const authorization = await pollDeviceCode(device)
  const tokens = await exchangeDeviceCode(authorization)
  await writeOpenAICodexAuth(tokens)
  log(`OpenAI Codex login saved to ${openAICodexAuthPath()}`)
  return tokens
}

async function readOpenAICodexAuth() {
  let raw
  try {
    raw = await readFile(openAICodexAuthPath(), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  return JSON.parse(raw)
}

async function writeOpenAICodexAuth(tokens) {
  const path = openAICodexAuthPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ tokens }, null, 2)}\n`, { mode: 0o600 })
}

function codexAuthHeaders(contentType) {
  return {
    'content-type': contentType,
    originator: 'lannr',
    'User-Agent': 'lannr-cli',
  }
}

async function requestDeviceCode() {
  const response = await fetch(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: codexAuthHeaders('application/json'),
    body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
  })
  const bodyText = await response.text()
  if (!response.ok) throw new Error(`OpenAI device code request failed: HTTP ${response.status} ${bodyText}`)
  const body = parseJson(bodyText)
  const deviceAuthId = stringOr(body.device_auth_id)
  const userCode = stringOr(body.user_code, body.usercode)
  if (!deviceAuthId || !userCode) throw new Error('OpenAI device code response was missing required fields.')
  return {
    deviceAuthId,
    userCode,
    verificationUrl: `${OPENAI_AUTH_BASE_URL}/codex/device`,
    intervalMs: secondsToMs(body.interval) ?? DEFAULT_POLL_INTERVAL_MS,
  }
}

async function pollDeviceCode({ deviceAuthId, userCode, intervalMs }) {
  const deadline = Date.now() + DEVICE_CODE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const response = await fetch(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: codexAuthHeaders('application/json'),
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    })
    const bodyText = await response.text()
    if (response.ok) {
      const body = parseJson(bodyText)
      const authorizationCode = stringOr(body.authorization_code)
      const codeVerifier = stringOr(body.code_verifier)
      if (!authorizationCode || !codeVerifier) throw new Error('OpenAI device authorization response was missing exchange fields.')
      return { authorizationCode, codeVerifier }
    }
    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`OpenAI device authorization failed: HTTP ${response.status} ${bodyText}`)
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))))
  }
  throw new Error('OpenAI device authorization timed out after 15 minutes.')
}

async function exchangeDeviceCode({ authorizationCode, codeVerifier }) {
  const response = await fetch(`${OPENAI_AUTH_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: codexAuthHeaders('application/x-www-form-urlencoded'),
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: OPENAI_CODEX_DEVICE_CALLBACK_URL,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  })
  const bodyText = await response.text()
  if (!response.ok) throw new Error(`OpenAI device token exchange failed: HTTP ${response.status} ${bodyText}`)
  const body = parseJson(bodyText)
  const accessToken = stringOr(body.access_token)
  const refreshToken = stringOr(body.refresh_token)
  if (!accessToken || !refreshToken) throw new Error('OpenAI token exchange response was missing tokens.')
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Date.now() + (secondsToMs(body.expires_in) ?? 0),
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`OpenAI returned invalid JSON: ${text}`)
  }
}

function stringOr(...values) {
  const value = values.find((item) => typeof item === 'string' && item.trim())
  return value?.trim()
}

function secondsToMs(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : undefined
}

async function openUrl(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}
