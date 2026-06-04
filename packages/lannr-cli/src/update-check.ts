import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { getCliVersion } from './version.js'
import { color } from './cli/help.js'

const PACKAGE_NAME = 'lannr-cli'
// Only hit the network once per day; every other invocation reads the cache
// written by a previous run, so commands never block on npm.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

type Cache = { lastCheck: number, latest: string | null }

function disabled(): boolean {
  return Boolean(process.env.LANNR_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER)
}

function lannrHome(): string {
  return process.env.LANNR_HOME ?? resolve(homedir(), '.lannr')
}

function cachePath(): string {
  return resolve(lannrHome(), 'update-check.json')
}

function readCache(): Cache {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8'))
    return { lastCheck: Number(parsed.lastCheck) || 0, latest: parsed.latest ?? null }
  } catch {
    return { lastCheck: 0, latest: null }
  }
}

function parseSemver(value: string): number[] {
  const core = String(value).trim().replace(/^v/, '').split(/[-+]/)[0]
  return core.split('.').map((part) => parseInt(part, 10) || 0)
}

function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest)
  const b = parseSemver(current)
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left > right) return true
    if (left < right) return false
  }
  return false
}

// Fire-and-forget the npm lookup in a detached child that writes the cache and
// exits on its own, so the foreground command is never delayed by the network.
function spawnBackgroundCheck(): void {
  const target = cachePath()
  const script = [
    "const { execFileSync } = require('node:child_process');",
    "const { writeFileSync, mkdirSync } = require('node:fs');",
    "const { dirname } = require('node:path');",
    'try {',
    `  const out = execFileSync('npm', ['view', ${JSON.stringify(PACKAGE_NAME)}, 'version'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 15000 }).trim();`,
    `  mkdirSync(dirname(${JSON.stringify(target)}), { recursive: true });`,
    `  writeFileSync(${JSON.stringify(target)}, JSON.stringify({ lastCheck: Date.now(), latest: out }));`,
    '} catch {}',
  ].join('\n')
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

// Refresh the cached "latest" version in the background when it is stale. Safe
// to call on every invocation; it no-ops when the cache is still fresh.
export function checkForUpdatesInBackground(): void {
  if (disabled()) return
  const { lastCheck } = readCache()
  if (Date.now() - lastCheck < CHECK_INTERVAL_MS) return
  try {
    spawnBackgroundCheck()
  } catch {
    // Never let an update check break a real command.
  }
}

const ANSI = /\x1b\[[0-9;]*m/g
const visibleLength = (value: string): number => value.replace(ANSI, '').length

function box(lines: string[]): string {
  const width = Math.max(...lines.map(visibleLength))
  const dashes = '─'.repeat(width + 2)
  const out = [color.yellow(`╭${dashes}╮`)]
  for (const line of lines) {
    const pad = ' '.repeat(width - visibleLength(line))
    out.push(`${color.yellow('│')} ${line}${pad} ${color.yellow('│')}`)
  }
  out.push(color.yellow(`╰${dashes}╯`))
  return out.map((line) => `  ${line}`).join('\n')
}

// Returns a rendered banner when the cached latest version is newer than the
// running one, or null when up to date / nothing checked yet.
export function getUpdateNotice(): string | null {
  if (disabled()) return null
  const { latest } = readCache()
  if (!latest) return null
  const current = getCliVersion()
  if (!isNewer(latest, current)) return null
  return box([
    `${color.bold('Update available')}  ${color.dim(`v${current}`)} ${color.yellow('→')} ${color.green(`v${latest}`)}`,
    `Run ${color.cyan('lannr update')} to install the latest version.`,
  ])
}
