import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const OPENAI_AUTH_BASE_URL = 'https://auth.openai.com'
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_CODEX_DEVICE_CALLBACK_URL = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`
const DEVICE_CODE_TIMEOUT_MS = 15 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 5_000

const OPENAI_AUTHORIZE_URL = `${OPENAI_AUTH_BASE_URL}/oauth/authorize`
const OPENAI_TOKEN_URL = `${OPENAI_AUTH_BASE_URL}/oauth/token`
const OPENAI_OAUTH_SCOPE = 'openid profile email offline_access'
const OPENAI_OAUTH_CALLBACK_HOST = 'localhost'
const OPENAI_OAUTH_CALLBACK_PORT = 1455
const OPENAI_OAUTH_CALLBACK_PATH = '/auth/callback'
const OPENAI_OAUTH_REDIRECT_URI = `http://${OPENAI_OAUTH_CALLBACK_HOST}:${OPENAI_OAUTH_CALLBACK_PORT}${OPENAI_OAUTH_CALLBACK_PATH}`
const BROWSER_AUTH_TIMEOUT_MS = 15 * 60_000

export type OpenAICodexAuthMode = 'browser' | 'device'

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

export async function loginOpenAICodex({ openBrowser = true, log = console.log, mode = 'browser' } = {}) {
  if (mode === 'device') return loginOpenAICodexWithDeviceCode({ openBrowser, log })
  return loginOpenAICodexWithBrowser({ openBrowser, log })
}

export async function loginOpenAICodexWithDeviceCode({ openBrowser = true, log = console.log } = {}) {
  log('Starting OpenAI Codex ChatGPT login...')
  const device = await requestDeviceCode()
  log(`Open this URL to sign in with ChatGPT: ${device.verificationUrl}`)
  log(`Enter code: ${device.userCode}`)
  if (openBrowser) await openUrl(device.verificationUrl)

  const authorization = await pollDeviceCode(device)
  const tokens = await exchangeCodeForTokens({
    authorizationCode: authorization.authorizationCode,
    codeVerifier: authorization.codeVerifier,
    redirectUri: OPENAI_CODEX_DEVICE_CALLBACK_URL,
    label: 'device token exchange',
  })
  await writeOpenAICodexAuth(tokens)
  log(`OpenAI Codex login saved to ${openAICodexAuthPath()}`)
  return tokens
}

export async function loginOpenAICodexWithBrowser({ openBrowser = true, log = console.log } = {}) {
  log('Starting OpenAI Codex ChatGPT login...')
  const { verifier, challenge } = generatePkce()
  const state = randomBytes(16).toString('hex')
  const authorizeUrl = buildAuthorizeUrl({ challenge, state })

  const server = await startLoopbackServer(state)
  try {
    log(`Open this URL to sign in with ChatGPT: ${authorizeUrl}`)
    if (openBrowser) await openUrl(authorizeUrl)
    log('Waiting for browser sign-in…')

    const code = await server.waitForCode()
    if (!code) throw new Error('OpenAI browser authorization was cancelled or timed out after 15 minutes.')

    const tokens = await exchangeCodeForTokens({
      authorizationCode: code,
      codeVerifier: verifier,
      redirectUri: OPENAI_OAUTH_REDIRECT_URI,
      label: 'token exchange',
    })
    await writeOpenAICodexAuth(tokens)
    log(`OpenAI Codex login saved to ${openAICodexAuthPath()}`)
    return tokens
  } finally {
    server.close()
  }
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

async function exchangeCodeForTokens({ authorizationCode, codeVerifier, redirectUri, label }) {
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: codexAuthHeaders('application/x-www-form-urlencoded'),
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: redirectUri,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  })
  const bodyText = await response.text()
  if (!response.ok) throw new Error(`OpenAI ${label} failed: HTTP ${response.status} ${bodyText}`)
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

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function generatePkce() {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function buildAuthorizeUrl({ challenge, state }) {
  const url = new URL(OPENAI_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', OPENAI_CODEX_CLIENT_ID)
  url.searchParams.set('redirect_uri', OPENAI_OAUTH_REDIRECT_URI)
  url.searchParams.set('scope', OPENAI_OAUTH_SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', 'lannr')
  return url.toString()
}

async function startLoopbackServer(expectedState) {
  let settle
  const codePromise = new Promise((resolveCode) => {
    let settled = false
    settle = (value) => {
      if (settled) return
      settled = true
      resolveCode(value)
    }
  })

  const sendHtml = (res, status, message) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(oauthResultHtml(status === 200 ? 'Authentication successful' : 'Authentication failed', message))
  }

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || '', `http://${OPENAI_OAUTH_CALLBACK_HOST}`)
      if (url.pathname !== OPENAI_OAUTH_CALLBACK_PATH) {
        sendHtml(res, 404, 'Callback route not found.')
        return
      }
      if (url.searchParams.get('state') !== expectedState) {
        sendHtml(res, 400, 'State mismatch — please retry the login.')
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        sendHtml(res, 400, 'Missing authorization code.')
        return
      }
      sendHtml(res, 200, 'OpenAI authentication completed. You can close this window and return to your terminal.')
      settle(code)
    } catch {
      sendHtml(res, 500, 'Internal error while processing the OAuth callback.')
    }
  })

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      const hint = error?.code === 'EADDRINUSE'
        ? ` Port ${OPENAI_OAUTH_CALLBACK_PORT} is already in use — close the other process or use device-code login instead.`
        : ''
      rejectListen(new Error(`Could not start the local OAuth callback server.${hint}`))
    }
    server.once('error', onError)
    server.listen(OPENAI_OAUTH_CALLBACK_PORT, OPENAI_OAUTH_CALLBACK_HOST, () => {
      server.removeListener('error', onError)
      resolveListen(undefined)
    })
  })

  const timeout = setTimeout(() => settle(null), BROWSER_AUTH_TIMEOUT_MS)
  timeout.unref?.()

  return {
    close: () => {
      clearTimeout(timeout)
      server.close()
    },
    waitForCode: () => codePromise,
  }
}

function oauthResultHtml(heading, message) {
  const safeHeading = escapeHtml(heading)
  const safeMessage = escapeHtml(message)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${safeHeading}</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#09090b;color:#fafafa;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center}main{max-width:480px}h1{font-size:24px;font-weight:650;margin:0 0 12px}p{margin:0;line-height:1.7;color:#a1a1aa;font-size:15px}</style></head><body><main><h1>${safeHeading}</h1><p>${safeMessage}</p></main></body></html>`
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
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
