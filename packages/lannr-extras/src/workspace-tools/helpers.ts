import { execFile } from 'node:child_process'
import { relative, resolve, sep } from 'node:path'

export const DEFAULT_TEXT_RESULT_CHARS = 16_000
export const DEFAULT_BASH_RESULT_CHARS = 8_000

export function safeWorkspacePath(workspace, inputPath, globalReach = false, extraRoots = []) {
  const resolved = resolve(workspace, inputPath)
  if (globalReach || isWithinRoot(workspace, resolved) || extraRoots.some((root) => isWithinRoot(root, resolved))) {
    return resolved
  }
  throw new Error(`Path escapes workspace: ${inputPath}`)
}

export function displayPath(workspace, filePath) {
  return isWithinRoot(workspace, filePath) ? toWorkspaceRelative(workspace, filePath) : resolve(filePath)
}

function isWithinRoot(root, filePath) {
  const rel = relative(resolve(root), resolve(filePath))
  if (rel.startsWith('..') || rel === '..' || rel.includes(`..${sep}`) || resolve(rel) === rel) {
    return false
  }
  return true
}

export function toWorkspaceRelative(workspace, filePath) {
  return relative(workspace, filePath) || '.'
}

export function truncateText(value, maxChars) {
  const text = String(value ?? '')
  if (text.length <= maxChars) return text
  const suffix = `\n\n[truncated ${text.length - maxChars} chars; increase maxChars or inspect a narrower range if needed]`
  const budget = Math.max(0, maxChars - suffix.length)
  if (budget <= 0) return suffix.slice(0, maxChars)

  const tail = text.slice(-Math.min(4_000, Math.floor(budget * 0.3))).toLowerCase()
  const keepTail = /\b(error|exception|failed|fatal|traceback|panic|stack trace|exit code|summary|result|total)\b/.test(tail)
  if (!keepTail || budget < 8_000) return `${text.slice(0, budget)}${suffix}`

  const tailChars = Math.min(4_000, Math.floor(budget * 0.3))
  const headChars = Math.max(0, budget - tailChars)
  return `${text.slice(0, headChars)}\n\n[... middle content omitted ...]\n\n${text.slice(-tailChars)}${suffix}`
}

export function runBash(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      '/bin/bash',
      ['-lc', command],
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
          signal: error?.signal ?? null,
          timedOut: Boolean(error?.killed && error?.signal === 'SIGTERM'),
        })
      },
    )
  })
}

export function truncateBashResult(result) {
  const stdout = truncateText(result.stdout, DEFAULT_BASH_RESULT_CHARS)
  const stderr = truncateText(result.stderr, DEFAULT_BASH_RESULT_CHARS)
  return {
    ...result,
    stdout,
    stderr,
    stdoutTruncated: result.stdout.length > stdout.length,
    stderrTruncated: result.stderr.length > stderr.length,
  }
}
