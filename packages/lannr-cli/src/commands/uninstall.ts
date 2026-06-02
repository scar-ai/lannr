import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { prompt } from '../cli/helpers.js'

function lannrHome(): string {
  return process.env.LANNR_HOME ?? resolve(homedir(), '.lannr')
}

function hubPidFile(): string {
  return join(lannrHome(), 'hub', 'hub.pid')
}

function readHubPid(): number | null {
  try {
    const pid = Number(readFileSync(hubPidFile(), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Stop the background hub daemon if it is running. Returns a human-readable
// status so the uninstall report can show what happened.
function stopHub(): string {
  const pid = readHubPid()
  if (!pid) return 'not running'
  if (!isRunning(pid)) {
    try { unlinkSync(hubPidFile()) } catch {}
    return 'stale pid cleared'
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error: any) {
    return `failed to stop (pid ${pid}): ${error?.message ?? error}`
  }
  try { unlinkSync(hubPidFile()) } catch {}
  return `stopped (pid ${pid})`
}

function dirSize(target: string): { bytes: number, files: number } {
  let bytes = 0
  let files = 0
  const walk = (p: string) => {
    let entries
    try { entries = readdirSync(p, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      try { bytes += statSync(full).size; files += 1 } catch {}
    }
  }
  try {
    if (statSync(target).isDirectory()) walk(target)
    else { bytes = statSync(target).size; files = 1 }
  } catch {}
  return { bytes, files }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value.toFixed(1)} ${units[unit]}`
}

type Manager = { cmd: string, args: string[], label: string }

// Where on PATH does the `lannr` bin actually live? We keep the symlink path
// itself (not its realpath target) because the directory tells us which package
// manager owns it — e.g. ~/Library/pnpm/lannr means pnpm, not npm.
function resolveLannrBin(): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? ['lannr'] : ['-v', 'lannr'], {
      encoding: 'utf8',
      shell: process.platform === 'win32' ? false : true,
    })
    const first = out.split('\n').map((l) => l.trim()).find(Boolean)
    return first || null
  } catch {
    return null
  }
}

// Infer the global package manager that installed the bin from its location.
// pnpm/yarn/bun keep their own global stores that `npm uninstall` never touches.
function managerFor(binPath: string | null): Manager {
  const p = (binPath ?? '').toLowerCase()
  if (p.includes('/library/pnpm/') || p.includes('/pnpm/') || p.includes('\\pnpm\\') || Boolean(process.env.PNPM_HOME) && p.includes('pnpm'))
    return { cmd: 'pnpm', args: ['remove', '-g', 'lannr-cli'], label: 'pnpm' }
  if (p.includes('/.bun/') || p.includes('\\.bun\\'))
    return { cmd: 'bun', args: ['remove', '-g', 'lannr-cli'], label: 'bun' }
  if (p.includes('/yarn/') || p.includes('/.config/yarn/') || p.includes('\\yarn\\'))
    return { cmd: 'yarn', args: ['global', 'remove', 'lannr-cli'], label: 'yarn' }
  return { cmd: 'npm', args: ['uninstall', '-g', 'lannr-cli'], label: 'npm' }
}

function manualHint(mgr: Manager): string {
  return `${mgr.cmd} ${mgr.args.join(' ')}`
}

// Remove the globally installed `lannr-cli` using whichever package manager owns
// it, then verify the bin is actually gone from PATH (npm/pnpm exit 0 even when
// nothing was removed, so the exit code alone is not trustworthy).
function removeGlobalBinary(): { ok: boolean, message: string, hint: string } {
  const before = resolveLannrBin()
  const mgr = managerFor(before)
  const hint = manualHint(mgr)

  const run = spawnSync(mgr.cmd, mgr.args, { stdio: 'ignore', shell: process.platform === 'win32' })
  if (run.error) {
    return { ok: false, message: `could not run ${mgr.label}: ${run.error.message}`, hint }
  }

  const after = resolveLannrBin()
  if (!after) return { ok: true, message: `removed via ${mgr.label}`, hint }
  if (before && after !== before) {
    // The owning copy was removed but another install still shadows it on PATH.
    return { ok: false, message: `removed ${before} via ${mgr.label}, but another lannr remains at ${after}`, hint }
  }
  return {
    ok: false,
    message: run.status === 0
      ? `${mgr.label} reported success but ${after} still resolves`
      : `${mgr.label} exited with code ${run.status}`,
    hint,
  }
}

export function register(program) {
  program.command('uninstall')
    .description('Completely and cleanly remove Lannr data, services, and (optionally) the CLI binary')
    .option('-y, --yes', 'skip the confirmation prompt')
    .option('--keep-data', 'remove the global CLI binary but keep ~/.lannr data')
    .option('--remove-binary', 'also uninstall the global lannr-cli package or linked bin')
    .option('--dry-run', 'show what would be removed without deleting anything')
    .option('--json', 'print the result as JSON')
    .action(async (opts) => {
      const home = lannrHome()
      const homeExists = existsSync(home)
      const removeData = !opts.keepData
      const { bytes, files } = removeData && homeExists ? dirSize(home) : { bytes: 0, files: 0 }

      // Detect how the bin was installed (npm package vs pnpm/yarn/bun global
      // link) so prompts and the dry-run report the command we'll actually run.
      const binPath = opts.removeBinary || opts.dryRun ? resolveLannrBin() : null
      const mgr = managerFor(binPath)

      const plan = {
        dataDir: home,
        dataDirExists: homeExists,
        removeData,
        removeBinary: Boolean(opts.removeBinary),
        binPath,
        binManager: mgr.label,
        files,
        size: formatBytes(bytes),
      }

      if (opts.dryRun) {
        if (opts.json) { console.log(JSON.stringify({ dryRun: true, plan }, null, 2)); return }
        console.log('Dry run — nothing will be removed.\n')
        if (removeData) {
          console.log(homeExists
            ? `Would stop the hub and delete ${plan.dataDir} (${files} files, ${plan.size}).`
            : `Data directory ${plan.dataDir} does not exist; nothing to delete.`)
        } else {
          console.log('Would keep the data directory (--keep-data).')
        }
        if (opts.removeBinary) {
          console.log(binPath
            ? `Would remove the ${mgr.label} bin at ${binPath} via: ${manualHint(mgr)}`
            : `Would run: ${manualHint(mgr)} (no lannr bin found on PATH)`)
        } else {
          console.log('Would leave the CLI binary installed (pass --remove-binary to remove it).')
        }
        return
      }

      if (!opts.yes && !opts.json) {
        console.log('This will permanently remove Lannr from this machine:')
        if (removeData) {
          console.log(homeExists
            ? `  • stop the background hub`
            : `  • (no running hub / data found)`)
          if (homeExists) console.log(`  • delete ${plan.dataDir} (${files} files, ${plan.size})`)
        } else {
          console.log('  • keep ~/.lannr data (--keep-data)')
        }
        if (opts.removeBinary) {
          console.log(binPath
            ? `  • uninstall the ${mgr.label} bin (${binPath})`
            : `  • uninstall the global lannr-cli package (none found on PATH)`)
        }
        const answer = (await prompt('\nType "uninstall" to confirm: ')).toLowerCase()
        if (answer !== 'uninstall' && answer !== 'yes' && answer !== 'y') {
          console.log('Aborted. Nothing was removed.')
          return
        }
      }

      const result: Record<string, any> = { dataDir: home }

      if (removeData) {
        result.hub = stopHub()
        if (homeExists) {
          try {
            rmSync(home, { recursive: true, force: true })
            result.data = `removed (${files} files, ${plan.size})`
          } catch (error: any) {
            result.data = `failed: ${error?.message ?? error}`
            process.exitCode = 1
          }
        } else {
          result.data = 'nothing to remove'
        }
      } else {
        result.data = 'kept (--keep-data)'
      }

      let binaryHint = manualHint(mgr)
      let binaryRemoved = false
      if (opts.removeBinary) {
        const binary = removeGlobalBinary()
        result.binary = binary.message
        binaryHint = binary.hint
        binaryRemoved = binary.ok
        if (!binary.ok) process.exitCode = 1
      } else {
        result.binary = 'left installed'
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }

      console.log('')
      if (removeData) console.log(`Hub:    ${result.hub}`)
      console.log(`Data:   ${result.data}`)
      console.log(`Binary: ${result.binary}`)
      if (!opts.removeBinary) {
        console.log('\nTo remove the CLI itself, run:')
        console.log(`  ${binaryHint}`)
      } else if (!binaryRemoved) {
        console.log('\nThe CLI binary could not be removed automatically. Remove it manually with:')
        console.log(`  ${binaryHint}`)
      }
      console.log('\nLannr has been uninstalled.')
    })
}
