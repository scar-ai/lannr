import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { tool } from 'lannr-core'
import { z } from 'zod'
import { assertSafeUrl } from './url-safety.js'
import { safeWorkspacePath, toWorkspaceRelative, truncateText } from './helpers.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_OUTPUT_CHARS = 48_000
const DIALOG_AUTO_HANDLE_MS = 5_000
const sessions = new Map()
let exitCleanupRegistered = false

const optionSchema = z.object({
  session: z.string().min(1).default('default'),
  headed: z.boolean().default(false),
  executablePath: z.string().optional(),
  userDataDir: z.string().optional(),
  cdpPort: z.number().int().min(1).max(65535).optional(),
  attach: z.boolean().default(false),
  cdpHost: z.string().default('127.0.0.1'),
  dialogPolicy: z.enum(['must_respond', 'auto_dismiss', 'auto_accept']).default('auto_dismiss'),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(DEFAULT_TIMEOUT_MS),
  maxOutput: z.number().int().min(1_000).max(500_000).default(DEFAULT_OUTPUT_CHARS),
  allowPrivateUrls: z.boolean().default(false),
})

const outputSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  session: z.string(),
})

function chromeCandidates() {
  return [
    process.env.LANNR_CHROME_BIN,
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...playwrightChromeCandidates(),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'google-chrome',
    'chromium',
    'chromium-browser',
  ].filter(Boolean)
}

function playwrightChromeCandidates() {
  const root = join(process.env.HOME ?? '', 'Library/Caches/ms-playwright')
  try {
    return readdirSync(root)
      .filter((name) => name.startsWith('chromium-'))
      .map((name) => join(root, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
  } catch {
    return []
  }
}

function resolveChrome(explicit) {
  if (explicit) return explicit
  for (const candidate of chromeCandidates()) {
    if (candidate.includes('/')) {
      if (!existsSync(candidate)) continue
    } else {
      const found = spawnSync('which', [candidate], { stdio: 'ignore' })
      if (found.status !== 0) continue
    }
    return candidate
  }
  return null
}

function httpJson(url, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try {
          resolvePromise(JSON.parse(body))
        } catch (err) {
          reject(new Error(`Invalid JSON from ${url}: ${err.message}`))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`Timed out fetching ${url}`)))
    req.on('error', reject)
  })
}

async function waitForJson(url, timeoutMs) {
  const start = Date.now()
  let lastError
  while (Date.now() - start < timeoutMs) {
    try {
      return await httpJson(url, 1_000)
    } catch (err) {
      lastError = err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`)
}

function parseWsUrl(wsUrl) {
  const url = new URL(wsUrl)
  if (url.protocol !== 'ws:') throw new Error(`Only local ws:// CDP URLs are supported: ${wsUrl}`)
  return { host: url.hostname, port: Number(url.port || 80), path: `${url.pathname}${url.search}` }
}

class CdpSocket {
  [key: string]: any

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.nextId = 1
    this.pending = new Map()
    this.eventHandlers = new Set()
    this.closeHandlers = new Set()
    this.closed = false
  }

  async connect(timeoutMs: number) {
    const { host, port, path } = parseWsUrl(this.wsUrl)
    this.socket = net.createConnection({ host, port })
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome CDP')), timeoutMs)
      this.socket.once('connect', () => {
        const key = randomBytes(16).toString('base64')
        const req = [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n')
        this.expectedAccept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
        this.socket.write(req)
      })
      this.socket.once('error', reject)
      this.socket.once('data', (chunk) => {
        const text = chunk.toString('utf8')
        if (!text.includes(' 101 ') || !text.toLowerCase().includes(this.expectedAccept.toLowerCase())) {
          reject(new Error(`Chrome rejected WebSocket handshake: ${text.slice(0, 200)}`))
          return
        }
        clearTimeout(timer)
        const splitAt = text.indexOf('\r\n\r\n') + 4
        this.buffer = chunk.slice(splitAt)
        this.socket.on('data', (data) => this.onData(data))
        this.socket.on('error', (err) => this.failAll(err))
        this.socket.on('close', () => this.failAll(new Error('Chrome CDP connection closed')))
        this.onData(Buffer.alloc(0))
        resolvePromise()
      })
    })
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = this.readFrame()
      if (!frame) return
      if (frame.opcode === 8) return
      if (frame.opcode !== 1) continue
      const msg = JSON.parse(frame.payload.toString('utf8'))
      if (msg.id && this.pending.has(msg.id)) {
        const { resolvePromise, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else resolvePromise(msg.result ?? {})
      } else if (msg.method) {
        for (const handler of this.eventHandlers) handler(msg)
      }
    }
  }

  readFrame() {
    if (this.buffer.length < 2) return null
    const first = this.buffer[0]
    const second = this.buffer[1]
    let offset = 2
    let len = second & 0x7f
    if (len === 126) {
      if (this.buffer.length < offset + 2) return null
      len = this.buffer.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (this.buffer.length < offset + 8) return null
      const high = this.buffer.readUInt32BE(offset)
      const low = this.buffer.readUInt32BE(offset + 4)
      len = high * 2 ** 32 + low
      offset += 8
    }
    const masked = Boolean(second & 0x80)
    const maskOffset = offset
    if (masked) offset += 4
    if (this.buffer.length < offset + len) return null
    let payload = this.buffer.slice(offset, offset + len)
    if (masked) {
      const mask = this.buffer.slice(maskOffset, maskOffset + 4)
      payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]))
    }
    this.buffer = this.buffer.slice(offset + len)
    return { opcode: first & 0x0f, payload }
  }

  sendFrame(text) {
    const payload = Buffer.from(text)
    const mask = randomBytes(4)
    let header
    if (payload.length < 126) {
      header = Buffer.alloc(2)
      header[1] = 0x80 | payload.length
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4)
      header[1] = 0x80 | 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[1] = 0x80 | 127
      header.writeUInt32BE(0, 2)
      header.writeUInt32BE(payload.length, 6)
    }
    header[0] = 0x81
    const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]))
    this.socket.write(Buffer.concat([header, mask, masked]))
  }

  command(method: string, params: Record<string, unknown> = {}, sessionId?: string | null, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Chrome CDP connection is closed'))
    const id = this.nextId++
    const message: Record<string, unknown> = { id, method, params }
    if (sessionId) message.sessionId = sessionId
    this.sendFrame(JSON.stringify(message))
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out running CDP command ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolvePromise: (value) => {
          clearTimeout(timer)
          resolvePromise(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
    })
  }

  close() {
    this.socket?.destroy()
  }

  onEvent(handler) {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onClose(handler) {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  failAll(error) {
    if (this.closed) return
    this.closed = true
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
    for (const handler of this.closeHandlers) handler(error)
  }
}

async function launchChrome(opts) {
  const chrome = resolveChrome(opts.executablePath)
  if (!chrome) throw new Error('Chrome was not found. Set LANNR_CHROME_BIN or pass executablePath.')
  const port = opts.cdpPort ?? 9222 + Math.floor(Math.random() * 1000)
  const userDataDir = opts.userDataDir ? resolve(opts.userDataDir) : await mkdtemp(join(tmpdir(), 'lannr-browser-'))
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-popup-blocking',
  ]
  if (!opts.headed) args.push('--headless=new', '--disable-gpu')
  args.push('about:blank')
  const proc = spawn(chrome, args, { stdio: 'ignore', detached: false })
  proc.on('error', () => {})
  proc.unref()
  return { proc, port, userDataDir, ownedUserDataDir: !opts.userDataDir }
}

async function getSession(ctx, rawOptions = {}) {
  const opts = optionSchema.parse(rawOptions)
  const existing = sessions.get(opts.session)
  if (existing) return existing

  let launch
  if (opts.attach) {
    const port = opts.cdpPort ?? 9222
    launch = { proc: null, port, userDataDir: null, ownedUserDataDir: false, attached: true, host: opts.cdpHost }
  } else {
    launch = { ...(await launchChrome(opts)), attached: false, host: '127.0.0.1' }
  }
  const version = await waitForJson(`http://${launch.host}:${launch.port}/json/version`, opts.timeoutMs) as { webSocketDebuggerUrl: string }
  const cdp = new CdpSocket(version.webSocketDebuggerUrl)
  await cdp.connect(opts.timeoutMs)
  const session = {
    id: opts.session,
    cdp,
    cdpPort: launch.port,
    cdpHost: launch.host,
    proc: launch.proc,
    attached: launch.attached,
    userDataDir: launch.userDataDir,
    ownedUserDataDir: launch.ownedUserDataDir,
    targetId: null,
    sessionId: null,
    activeTargetId: null,
    pages: new Map(),
    targetSessions: new Map(),
    sessionTargets: new Map(),
    frames: new Map(),
    refMap: new Map(),
    pendingDialogs: [],
    dialogPolicy: opts.dialogPolicy,
    nextDialogId: 1,
    maxOutput: opts.maxOutput,
    workspace: ctx.workspace,
  }
  cdp.onEvent((message) => handleCdpEvent(session, message))
  cdp.onClose(() => {
    sessions.delete(session.id)
  })
  launch.proc?.on('exit', () => {
    sessions.delete(session.id)
    cdp.failAll(new Error('Chrome process exited'))
  })
  await cdp.command('Target.setDiscoverTargets', { discover: true })
  await cdp.command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  const targets = await cdp.command('Target.getTargets', {})
  const pages = targets.targetInfos?.filter((info) => info.type === 'page') ?? []
  let target = session.attached
    ? (pages.find((info) => info.attached) ?? pages[0])
    : pages.find((info) => info.url === 'about:blank')
  if (!target) target = await cdp.command('Target.createTarget', { url: 'about:blank' })
  let attached = await waitForTargetSession(session, target.targetId, opts.timeoutMs).catch(() => null)
  if (!attached) {
    attached = await cdp.command('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    registerTargetSession(session, target.targetId, attached.sessionId)
  }
  session.targetId = target.targetId
  session.sessionId = attached.sessionId
  session.activeTargetId = target.targetId
  session.pages.set(target.targetId, { targetId: target.targetId, sessionId: attached.sessionId, url: 'about:blank', title: '', type: 'page' })
  await enableTarget(session, attached.sessionId, opts.timeoutMs)
  sessions.set(opts.session, session)
  registerExitCleanup()
  return session
}

function registerTargetSession(session, targetId, targetSessionId) {
  session.targetSessions.set(targetId, targetSessionId)
  session.sessionTargets.set(targetSessionId, targetId)
}

async function waitForTargetSession(session, targetId, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const sessionId = session.targetSessions.get(targetId)
    if (sessionId) return { sessionId }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Timed out waiting for target ${targetId}`)
}

function activePage(session) {
  return session.pages.get(session.activeTargetId) ?? session.pages.values().next().value
}

function activeSessionId(session) {
  return activePage(session)?.sessionId ?? session.sessionId
}

async function enableTarget(session, targetSessionId, timeoutMs) {
  await session.cdp.command('Page.enable', {}, targetSessionId, timeoutMs).catch(() => {})
  await session.cdp.command('Runtime.enable', {}, targetSessionId, timeoutMs).catch(() => {})
  await session.cdp.command('DOM.enable', {}, targetSessionId, timeoutMs).catch(() => {})
  await session.cdp.command('Accessibility.enable', {}, targetSessionId, timeoutMs).catch(() => {})
}

function handleCdpEvent(session, message) {
  const { method, params = {}, sessionId } = message
  if (method === 'Target.attachedToTarget') {
    const info = params.targetInfo ?? {}
    registerTargetSession(session, info.targetId, params.sessionId)
    if (info.type === 'page') {
      session.pages.set(info.targetId, {
        targetId: info.targetId,
        sessionId: params.sessionId,
        url: info.url ?? '',
        title: info.title ?? '',
        type: info.type,
      })
      if (!session.activeTargetId || info.openerId) session.activeTargetId = info.targetId
    } else if (info.type === 'iframe') {
      session.frames.set(info.targetId, { frameId: info.targetId, sessionId: params.sessionId, url: info.url ?? '' })
    }
    enableTarget(session, params.sessionId, DEFAULT_TIMEOUT_MS).catch(() => {})
    return
  }
  if (method === 'Target.detachedFromTarget') {
    const targetId = session.sessionTargets.get(params.sessionId)
    session.targetSessions.delete(targetId)
    session.sessionTargets.delete(params.sessionId)
    session.pages.delete(targetId)
    if (session.activeTargetId === targetId) session.activeTargetId = session.pages.keys().next().value ?? null
    return
  }
  if (method === 'Target.targetInfoChanged') {
    const info = params.targetInfo ?? {}
    const page = session.pages.get(info.targetId)
    if (page) {
      page.url = info.url ?? page.url
      page.title = info.title ?? page.title
    }
    return
  }
  if (method === 'Page.frameAttached') {
    session.frames.set(params.frameId, { frameId: params.frameId, parentFrameId: params.parentFrameId, sessionId })
    return
  }
  if (method === 'Page.frameNavigated') {
    const frame = params.frame ?? {}
    session.frames.set(frame.id, { frameId: frame.id, parentFrameId: frame.parentId, url: frame.url, sessionId })
    return
  }
  if (method === 'Page.frameDetached') {
    session.frames.delete(params.frameId)
    return
  }
  if (method === 'Page.javascriptDialogOpening') {
    addDialog(session, sessionId, params)
  }
}

function addDialog(session, targetSessionId, params) {
  const dialog: Record<string, any> = {
    id: `dialog-${session.nextDialogId++}`,
    sessionId: targetSessionId,
    type: params.type,
    message: params.message ?? '',
    defaultPrompt: params.defaultPrompt ?? '',
  }
  session.pendingDialogs.push(dialog)
  if (session.dialogPolicy === 'must_respond') return
  const accept = session.dialogPolicy === 'auto_accept'
  dialog.timer = setTimeout(() => {
    handleDialog(session, dialog.id, accept).catch(() => {})
  }, DIALOG_AUTO_HANDLE_MS)
}

async function handleDialog(session, dialogId, accept, promptText = undefined) {
  const dialog = dialogId
    ? session.pendingDialogs.find((item) => item.id === dialogId)
    : session.pendingDialogs[session.pendingDialogs.length - 1]
  if (!dialog) throw new Error('No pending dialog')
  clearTimeout(dialog.timer)
  await session.cdp.command('Page.handleJavaScriptDialog', { accept, promptText }, dialog.sessionId, DEFAULT_TIMEOUT_MS)
  session.pendingDialogs = session.pendingDialogs.filter((item) => item !== dialog)
  return { handled: dialog.id, action: accept ? 'accept' : 'dismiss' }
}

function serializeDialogs(session) {
  return session.pendingDialogs.map(({ id, type, message, defaultPrompt }) => ({ id, type, message, defaultPrompt }))
}

function registerExitCleanup() {
  if (exitCleanupRegistered) return
  exitCleanupRegistered = true
  const cleanup = () => {
    for (const session of sessions.values()) {
      try { session.cdp.close() } catch {}
      if (session.proc) terminateProcessNow(session.proc)
    }
  }
  process.once('exit', cleanup)
  process.once('SIGINT', () => {
    cleanup()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    cleanup()
    process.exit(143)
  })
}

function terminateProcessNow(proc) {
  try { proc.kill('SIGTERM') } catch {}
  const timer = setTimeout(() => {
    if (proc.exitCode == null && proc.signalCode == null) {
      try { proc.kill('SIGKILL') } catch {}
    }
  }, 1_000)
  timer.unref?.()
}

async function terminateProcess(proc) {
  if (proc.exitCode != null || proc.signalCode != null) return
  await new Promise<void>((resolvePromise) => {
    const done = () => {
      clearTimeout(forceTimer)
      clearTimeout(doneTimer)
      resolvePromise()
    }
    const forceTimer = setTimeout(() => {
      if (proc.exitCode == null && proc.signalCode == null) {
        try { proc.kill('SIGKILL') } catch {}
      }
    }, 1_000)
    const doneTimer = setTimeout(done, 2_000)
    proc.once('exit', done)
    try { proc.kill('SIGTERM') } catch { done() }
  })
}

async function closeSession(id, all = false) {
  const items = all ? [...sessions.values()] : [sessions.get(id)].filter(Boolean)
  for (const session of items) {
    for (const dialog of session.pendingDialogs) clearTimeout(dialog.timer)
    if (!session.attached) {
      for (const targetId of session.pages.keys()) {
        try { await session.cdp.command('Target.closeTarget', { targetId }) } catch {}
      }
    }
    session.cdp.close()
    if (session.proc) await terminateProcess(session.proc)
    if (session.ownedUserDataDir) await rm(session.userDataDir, { recursive: true, force: true }).catch(() => {})
    sessions.delete(session.id)
  }
  return { closed: items.map((s) => s.id) }
}

async function evaluate(session, expression, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const result = await session.cdp.command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, activeSessionId(session), timeoutMs)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Evaluation failed')
  return result.result?.value
}

function jsString(value) {
  return JSON.stringify(String(value))
}

async function resolveElementObject(session, selector, timeoutMs) {
  const ref = selector.startsWith('@') ? session.refMap.get(selector) : null
  if (selector.startsWith('@') && !ref) throw new Error(`Unknown element ref: ${selector}`)
  const targetSessionId = ref?.sessionId ?? activeSessionId(session)
  if (ref) {
    const resolved = await session.cdp.command('DOM.resolveNode', { backendNodeId: ref.backendNodeId }, targetSessionId, timeoutMs)
    return { objectId: resolved.object?.objectId, targetSessionId, ref }
  }
  const result = await session.cdp.command('Runtime.evaluate', {
    expression: `document.querySelector(${jsString(selector)})`,
    returnByValue: false,
    userGesture: true,
  }, targetSessionId, timeoutMs)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Selector evaluation failed')
  if (!result.result?.objectId || result.result.subtype === 'null') throw new Error(`Element not found: ${selector}`)
  return { objectId: result.result.objectId, targetSessionId, ref: null }
}

async function callElementFunction(session, selector, functionDeclaration, timeoutMs, args = []) {
  const target = await resolveElementObject(session, selector, timeoutMs)
  const result = await session.cdp.command('Runtime.callFunctionOn', {
    objectId: target.objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, target.targetSessionId, timeoutMs)
  await session.cdp.command('Runtime.releaseObject', { objectId: target.objectId }, target.targetSessionId, timeoutMs).catch(() => {})
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description
    throw new Error(description || result.exceptionDetails.text || 'Element call failed')
  }
  return { value: result.result?.value, targetSessionId: target.targetSessionId }
}

async function elementInfo(session, selector, timeoutMs) {
  const { value, targetSessionId } = await callElementFunction(session, selector, `function () {
    this.scrollIntoView({ block: 'center', inline: 'center' });
    const box = this.getBoundingClientRect();
    if (!box.width || !box.height) throw new Error('Element is not visible');
    let frameX = 0;
    let frameY = 0;
    try {
      for (let win = window; win.frameElement; win = win.parent) {
        const frameBox = win.frameElement.getBoundingClientRect();
        frameX += frameBox.x;
        frameY += frameBox.y;
      }
    } catch {}
    return {
      x: box.x + frameX,
      y: box.y + frameY,
      width: box.width,
      height: box.height,
      centerX: box.x + frameX + box.width / 2,
      centerY: box.y + frameY + box.height / 2,
      tag: this.tagName,
      type: this.getAttribute('type') || '',
      editable: Boolean(this.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(this.tagName)),
    };
  }`, timeoutMs)
  return { ...value, targetSessionId }
}

async function mouseClick(session, selector, timeoutMs) {
  const box = await elementInfo(session, selector, timeoutMs)
  session.lastInputSessionId = box.targetSessionId
  await session.cdp.command('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: box.centerX,
    y: box.centerY,
    button: 'none',
  }, box.targetSessionId, timeoutMs)
  await session.cdp.command('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.centerX,
    y: box.centerY,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  }, box.targetSessionId, timeoutMs)
  await session.cdp.command('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.centerX,
    y: box.centerY,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  }, box.targetSessionId, timeoutMs)
  return box
}

const KEY_DEFINITIONS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
}

function keyDefinition(key) {
  const normalized = key === ' ' ? 'Space' : key
  if (KEY_DEFINITIONS[normalized]) return KEY_DEFINITIONS[normalized]
  if (/^[a-zA-Z]$/.test(normalized)) {
    const upper = normalized.toUpperCase()
    return { key: normalized, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: normalized }
  }
  if (/^\d$/.test(normalized)) {
    return { key: normalized, code: `Digit${normalized}`, keyCode: normalized.charCodeAt(0), text: normalized }
  }
  if (normalized.length === 1) {
    return { key: normalized, code: '', keyCode: normalized.toUpperCase().charCodeAt(0), text: normalized }
  }
  return { key: normalized, code: normalized, keyCode: 0 }
}

async function pressKey(session, key, timeoutMs, modifiers = 0) {
  const def = keyDefinition(key)
  const text = modifiers ? undefined : def.text
  const targetSessionId = session.lastInputSessionId ?? activeSessionId(session)
  await session.cdp.command('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    text,
    unmodifiedText: def.text,
    modifiers,
  }, targetSessionId, timeoutMs)
  await session.cdp.command('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
  }, targetSessionId, timeoutMs)
}

async function waitReady(session, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const state = await evaluate(session, 'document.readyState', timeoutMs)
    if (state === 'interactive' || state === 'complete') return
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function ok(ctx, options, fn) {
  const opts = optionSchema.parse(options ?? {})
  try {
    const data = await fn(opts)
    return { success: true, data, session: opts.session }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), session: opts.session }
  }
}

function truncateData(data, maxChars) {
  if (typeof data === 'string') return truncateText(data, maxChars)
  return data
}

const INTERACTIVE_AX_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
])

function axValue(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object' && 'value' in value) return String(value.value ?? '')
  return String(value)
}

function axDepth(node, nodesById) {
  let depth = 0
  let current = node
  while (current?.parentId && depth < 12) {
    depth += 1
    current = nodesById.get(current.parentId)
  }
  return depth
}

async function pageTitleUrl(session, targetSessionId, timeoutMs) {
  const result = await session.cdp.command('Runtime.evaluate', {
    expression: '({ title: document.title, url: location.href })',
    returnByValue: true,
  }, targetSessionId, timeoutMs)
  return result.result?.value ?? { title: '', url: '' }
}

async function snapshotTarget(session, page, timeoutMs, refStart, frameId = undefined) {
  const { nodes = [] } = await session.cdp.command('Accessibility.getFullAXTree', {
    depth: -1,
    ...(frameId ? { frameId } : {}),
  }, page.sessionId, timeoutMs)
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]))
  const header = await pageTitleUrl(session, page.sessionId, timeoutMs).catch(() => ({ title: page.title ?? '', url: page.url ?? '' }))
  page.title = header.title
  page.url = header.url
  const lines = [`Page: ${header.title}`, `URL: ${header.url}`]
  const refs = new Map()
  let index = refStart
  for (const node of nodes) {
    const role = axValue(node.role)
    const name = axValue(node.name).replace(/\s+/g, ' ').trim().slice(0, 160)
    if (node.ignored || !node.backendDOMNodeId || !INTERACTIVE_AX_ROLES.has(role)) continue
    const ref = `@e${index++}`
    const indent = '  '.repeat(Math.min(axDepth(node, nodesById), 8))
    refs.set(ref, {
      ref,
      backendNodeId: node.backendDOMNodeId,
      role,
      name,
      frameId: node.frameId ?? frameId,
      targetId: page.targetId,
      sessionId: page.sessionId,
    })
    lines.push(`${indent}${ref} ${role}${name ? ` "${name}"` : ''}`)
  }
  return { title: header.title, url: header.url, lines, refs, nextRef: index }
}

function flattenFrameTree(frameTree, out = []) {
  if (!frameTree) return out
  if (frameTree.frame) out.push(frameTree.frame)
  for (const child of frameTree.childFrames ?? []) flattenFrameTree(child, out)
  return out
}

async function browserSnapshot(session, timeoutMs) {
  const page = activePage(session)
  if (!page) throw new Error('No active browser tab')
  if (session.pendingDialogs.length) {
    return {
      title: page.title ?? '',
      url: page.url ?? '',
      snapshot: [
        `Page: ${page.title ?? ''}`,
        `URL: ${page.url ?? ''}`,
        ...serializeDialogs(session).map((dialog) => `Dialog ${dialog.id} ${dialog.type}: ${dialog.message}`),
      ].join('\n'),
      refs: {},
      dialogs: serializeDialogs(session),
    }
  }
  let result = await snapshotTarget(session, page, timeoutMs, 1)
  const frameTree = await session.cdp.command('Page.getFrameTree', {}, page.sessionId, timeoutMs).catch(() => null)
  for (const frame of flattenFrameTree(frameTree?.frameTree).slice(1)) {
    const frameSnapshot = await snapshotTarget(session, page, timeoutMs, result.nextRef, frame.id).catch(() => null)
    if (!frameSnapshot) continue
    result.lines.push(`Frame: ${frame.url || frame.id}`)
    result.lines.push(...frameSnapshot.lines.slice(2))
    for (const [ref, value] of frameSnapshot.refs) result.refs.set(ref, value)
    result.nextRef = frameSnapshot.nextRef
  }
  for (const frame of session.frames.values()) {
    if (!frame.sessionId || frame.sessionId === page.sessionId) continue
    const framePage = { targetId: frame.frameId, sessionId: frame.sessionId, url: frame.url ?? '', title: 'iframe' }
    const frameSnapshot = await snapshotTarget(session, framePage, timeoutMs, result.nextRef).catch(() => null)
    if (!frameSnapshot) continue
    result.lines.push(`Frame: ${frameSnapshot.url || frame.frameId}`)
    result.lines.push(...frameSnapshot.lines.slice(2))
    for (const [ref, value] of frameSnapshot.refs) result.refs.set(ref, value)
    result.nextRef = frameSnapshot.nextRef
  }
  session.refMap = result.refs
  return {
    title: result.title,
    url: result.url,
    snapshot: result.lines.join('\n'),
    refs: Object.fromEntries([...result.refs].map(([ref, value]) => [ref, { role: value.role, name: value.name }])),
    dialogs: serializeDialogs(session),
  }
}

export function createBrowserTools(ctx) {
  const common = optionSchema.partial()
  return [
    tool({
      name: 'browserOpen',
      desc: 'Launch or reuse a Chrome browser session and navigate to a URL. Set options.attach=true (with optional options.cdpPort, default 9222) to take over a Chrome already running with --remote-debugging-port=<port> instead of spawning a new one.',
      input: z.object({ url: z.string().optional(), options: common.default({}) }),
      output: outputSchema,
      sideEffect: true,
      handler: async ({ url, options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        if (url) {
          const navUrl = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url) ? url : `https://${url}`
          await assertSafeUrl(navUrl, { allowPrivate: opts.allowPrivateUrls })
          await session.cdp.command('Page.navigate', { url: navUrl }, activeSessionId(session), opts.timeoutMs)
          await waitReady(session, opts.timeoutMs)
        }
        return { url: await evaluate(session, 'location.href'), title: await evaluate(session, 'document.title'), cdpPort: session.cdpPort }
      }),
    }),
    tool({
      name: 'browserSnapshot',
      desc: 'Return an interactive DOM snapshot with @refs for browserClick/browserFill/browserType.',
      input: z.object({ options: common.default({}) }),
      output: outputSchema,
      handler: async ({ options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        const data = await browserSnapshot(session, opts.timeoutMs)
        return { ...data, snapshot: truncateText(data.snapshot, opts.maxOutput) }
      }),
    }),
    tool({
      name: 'browserClick',
      desc: 'Click an element by @ref from browserSnapshot or CSS selector.',
      input: z.object({ selector: z.string().min(1), options: common.default({}) }),
      output: outputSchema,
      sideEffect: true,
      handler: async ({ selector, options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        await mouseClick(session, selector, opts.timeoutMs)
        return { clicked: selector }
      }),
    }),
    tool({
      name: 'browserFill',
      desc: 'Clear and fill an input, textarea, select, or contenteditable element.',
      input: z.object({ selector: z.string().min(1), text: z.string(), options: common.default({}) }),
      output: outputSchema,
      sideEffect: true,
      handler: async ({ selector, text, options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        const box = await mouseClick(session, selector, opts.timeoutMs)
        const selectModifier = process.platform === 'darwin' ? 4 : 2
        await pressKey(session, 'A', opts.timeoutMs, selectModifier)
        await pressKey(session, 'Backspace', opts.timeoutMs)
        await session.cdp.command('Input.insertText', { text }, box.targetSessionId, opts.timeoutMs)
        await session.cdp.command('Runtime.evaluate', {
          expression: `(() => {
            const el = document.activeElement;
            if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()`,
          returnByValue: true,
        }, box.targetSessionId, opts.timeoutMs).catch(() => true)
        return { filled: selector }
      }),
    }),
    tool({
      name: 'browserType',
      desc: 'Focus an element and type text using CDP keyboard events.',
      input: z.object({ selector: z.string().min(1), text: z.string(), options: common.default({}) }),
      output: outputSchema,
      sideEffect: true,
      handler: async ({ selector, text, options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        const box = await mouseClick(session, selector, opts.timeoutMs)
        await session.cdp.command('Input.insertText', { text }, box.targetSessionId, opts.timeoutMs)
        return { typed: text.length, selector }
      }),
    }),
    tool({
      name: 'browserPress',
      desc: 'Press a key such as Enter, Tab, Escape, Backspace, ArrowDown, or Space.',
      input: z.object({ key: z.string().min(1), options: common.default({}) }),
      output: outputSchema,
      sideEffect: true,
      handler: async ({ key, options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        await pressKey(session, key, opts.timeoutMs)
        return { pressed: key }
      }),
    }),
    tool({
      name: 'browserMouseClick',
      desc: 'Click absolute viewport coordinates from a screenshot when no selector/ref is available.',
      input: z.object({
        x: z.number(),
        y: z.number(),
        options: common.default({}),
      }),
      output: outputSchema,
      sideEffect: true,
      handler: async ({ x, y, options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        await session.cdp.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, activeSessionId(session), opts.timeoutMs)
        await session.cdp.command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, activeSessionId(session), opts.timeoutMs)
        await session.cdp.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, activeSessionId(session), opts.timeoutMs)
        return { clicked: { x, y } }
      }),
    }),
    tool({
      name: 'browserScroll',
      desc: 'Scroll the page or the element under the pointer by mouse wheel delta.',
      input: z.object({
        deltaY: z.number().default(600),
        deltaX: z.number().default(0),
        x: z.number().default(400),
        y: z.number().default(400),
        options: common.default({}),
      }),
      output: outputSchema,
      sideEffect: true,
      handler: async ({ deltaY = 600, deltaX = 0, x = 400, y = 400, options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        await session.cdp.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY }, activeSessionId(session), opts.timeoutMs)
        return { scrolled: { deltaX, deltaY, x, y } }
      }),
    }),
    tool({
      name: 'browserWait',
      desc: 'Wait for milliseconds or for a selector/@ref to exist.',
      input: z.object({ target: z.union([z.string().min(1), z.number().int().min(0)]), options: common.default({}) }),
      output: outputSchema,
      handler: async ({ target, options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        if (typeof target === 'number') {
          await new Promise((r) => setTimeout(r, target))
          return { waitedMs: target }
        }
        const start = Date.now()
        while (Date.now() - start < opts.timeoutMs) {
          const found = await resolveElementObject(session, target, opts.timeoutMs).then(() => true).catch(() => false)
          if (found) return { found: target }
          await new Promise((r) => setTimeout(r, 100))
        }
        throw new Error(`Timed out waiting for ${target}`)
      }),
    }),
    tool({
      name: 'browserGet',
      desc: 'Read page state: text, html, value, attr, title, url, count, or box.',
      input: z.object({
        what: z.enum(['text', 'html', 'value', 'attr', 'title', 'url', 'count', 'box']),
        selector: z.string().optional(),
        attribute: z.string().optional(),
        options: common.default({}),
      }),
      output: outputSchema,
      handler: async ({ what, selector, attribute, options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        if (what === 'title') return { title: await evaluate(session, 'document.title', opts.timeoutMs) }
        if (what === 'url') return { url: await evaluate(session, 'location.href', opts.timeoutMs) }
        if (!selector) throw new Error(`${what} requires selector`)
        if (what === 'count') {
          if (selector.startsWith('@')) return { count: session.refMap.has(selector) ? 1 : 0 }
          return { count: await evaluate(session, `document.querySelectorAll(${jsString(selector)}).length`, opts.timeoutMs) }
        }
        const fn = {
          text: 'function () { return this.innerText || this.textContent || "" }',
          html: 'function () { return this.innerHTML }',
          value: 'function () { return this.value ?? "" }',
          attr: 'function (name) { return this.getAttribute(name) }',
          box: 'function () { return JSON.parse(JSON.stringify(this.getBoundingClientRect())) }',
        }[what]
        const { value } = await callElementFunction(session, selector, fn, opts.timeoutMs, what === 'attr' ? [attribute ?? ''] : [])
        return { [what]: truncateData(value, opts.maxOutput) }
      }),
    }),
    tool({
      name: 'browserScreenshot',
      desc: 'Capture a PNG screenshot. Save to workspace path when path is provided.',
      input: z.object({ path: z.string().optional(), full: z.boolean().default(false), options: common.default({}) }),
      output: outputSchema,
      sideEffect: true,
      handler: async ({ path, full = false, options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        const shot = await session.cdp.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full }, activeSessionId(session), opts.timeoutMs)
        if (!path) return { base64: shot.data }
        const filePath = safeWorkspacePath(ctx.workspace, path, ctx.globalReach)
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, Buffer.from(shot.data, 'base64'))
        return { path: toWorkspaceRelative(ctx.workspace, filePath), bytes: Buffer.byteLength(shot.data, 'base64') }
      }),
    }),
    tool({
      name: 'browserEvaluate',
      desc: 'Evaluate JavaScript in the current page and return a JSON-serializable result.',
      input: z.object({ script: z.string().min(1), options: common.default({}) }),
      output: outputSchema,
      sideEffect: true,
      handler: async ({ script, options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        return { result: truncateData(await evaluate(session, script, opts.timeoutMs), opts.maxOutput) }
      }),
    }),
    tool({
      name: 'browserDialog',
      desc: 'Accept or dismiss a pending JavaScript dialog.',
      input: z.object({
        action: z.enum(['accept', 'dismiss']).default('dismiss'),
        dialogId: z.string().optional(),
        promptText: z.string().optional(),
        options: common.default({}),
      }),
      output: outputSchema,
      sideEffect: true,
      handler: async ({ action = 'dismiss', dialogId, promptText, options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        return handleDialog(session, dialogId, action === 'accept', promptText)
      }),
    }),
    tool({
      name: 'browserTabs',
      desc: 'List open browser tabs and the active tab.',
      input: z.object({ options: common.default({}) }),
      output: outputSchema,
      handler: async ({ options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        for (const page of session.pages.values()) {
          const info = await pageTitleUrl(session, page.sessionId, opts.timeoutMs).catch(() => null)
          if (info) {
            page.title = info.title
            page.url = info.url
          }
        }
        return {
          activeIndex: [...session.pages.keys()].indexOf(session.activeTargetId),
          tabs: [...session.pages.values()].map((page, index) => ({
            index,
            active: page.targetId === session.activeTargetId,
            targetId: page.targetId,
            title: page.title,
            url: page.url,
            label: page.label,
          })),
        }
      }),
    }),
    tool({
      name: 'browserTabSwitch',
      desc: 'Switch the active browser tab by index or label.',
      input: z.object({
        index: z.number().int().min(0).optional(),
        label: z.string().optional(),
        options: common.default({}),
      }),
      output: outputSchema,
      sideEffect: true,
      handler: async ({ index, label, options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        const tabs = [...session.pages.values()]
        const page = label ? tabs.find((item) => item.label === label || item.title === label || item.targetId === label) : tabs[index ?? 0]
        if (!page) throw new Error('Browser tab not found')
        session.activeTargetId = page.targetId
        await session.cdp.command('Target.activateTarget', { targetId: page.targetId }, undefined, opts.timeoutMs).catch(() => {})
        return { active: { index: tabs.indexOf(page), targetId: page.targetId, title: page.title, url: page.url } }
      }),
    }),
    tool({
      name: 'browserTabClose',
      desc: 'Close a browser tab by index or label, defaulting to the active tab.',
      input: z.object({
        index: z.number().int().min(0).optional(),
        label: z.string().optional(),
        options: common.default({}),
      }),
      output: outputSchema,
      sideEffect: true,
      handler: async ({ index, label, options = {} }) => ok(ctx, options, async (opts) => {
        const session = await getSession(ctx, opts)
        const tabs = [...session.pages.values()]
        const page = label
          ? tabs.find((item) => item.label === label || item.title === label || item.targetId === label)
          : index == null ? activePage(session) : tabs[index]
        if (!page) throw new Error('Browser tab not found')
        await session.cdp.command('Target.closeTarget', { targetId: page.targetId }, undefined, opts.timeoutMs)
        session.pages.delete(page.targetId)
        if (session.activeTargetId === page.targetId) session.activeTargetId = session.pages.keys().next().value ?? null
        return { closed: page.targetId, activeTargetId: session.activeTargetId }
      }),
    }),
    tool({
      name: 'browserClose',
      desc: 'Close the browser session, or every browser session when all is true.',
      input: z.object({ all: z.boolean().default(false), options: common.default({}) }),
      output: outputSchema,
      sideEffect: true,
      handler: async ({ all = false, options = {} }) => ok(ctx, options, async (opts) => closeSession(opts.session, all)),
    }),
  ]
}
