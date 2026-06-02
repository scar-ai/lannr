import { execFileSync, spawnSync } from 'node:child_process'
import { getCliVersion } from '../version.js'

type ManagerName = 'npm' | 'pnpm' | 'yarn' | 'bun'
type Manager = { name: ManagerName, cmd: string, args: string[] }

const PACKAGE_NAME = 'lannr-cli'

function resolveLannrBin(): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? ['lannr'] : ['-v', 'lannr'], {
      encoding: 'utf8',
      shell: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split('\n').map((line) => line.trim()).find(Boolean) ?? null
  } catch {
    return null
  }
}

function installCommand(name: ManagerName, spec = `${PACKAGE_NAME}@latest`): Manager {
  if (name === 'pnpm') return { name, cmd: 'pnpm', args: ['add', '-g', spec] }
  if (name === 'yarn') return { name, cmd: 'yarn', args: ['global', 'add', spec] }
  if (name === 'bun') return { name, cmd: 'bun', args: ['add', '-g', spec] }
  return { name: 'npm', cmd: 'npm', args: ['install', '-g', spec] }
}

function managerFor(binPath: string | null, requested?: ManagerName): Manager {
  if (requested) return installCommand(requested)

  const p = (binPath ?? '').toLowerCase()
  if (p.includes('/library/pnpm/') || p.includes('/pnpm/') || p.includes('\\\\pnpm\\\\') || (Boolean(process.env.PNPM_HOME) && p.includes('pnpm'))) {
    return installCommand('pnpm')
  }
  if (p.includes('/.bun/') || p.includes('\\\\.bun\\\\')) return installCommand('bun')
  if (p.includes('/yarn/') || p.includes('/.config/yarn/') || p.includes('\\\\yarn\\\\')) return installCommand('yarn')
  return installCommand('npm')
}

function latestPublishedVersion(): string {
  const out = execFileSync('npm', ['view', PACKAGE_NAME, 'version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return out.trim()
}

function runUpdate(manager: Manager) {
  return spawnSync(manager.cmd, manager.args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

function commandText(manager: Manager): string {
  return `${manager.cmd} ${manager.args.join(' ')}`
}

export function register(program) {
  program.command('update')
    .description('Update the Lannr CLI to the latest published version')
    .option('--dry-run', 'show the update command without running it')
    .option('--json', 'print JSON')
    .option('--manager <manager>', 'override package manager: npm, pnpm, yarn, or bun')
    .action(async (opts) => {
      const requested = opts.manager as ManagerName | undefined
      if (requested && !['npm', 'pnpm', 'yarn', 'bun'].includes(requested)) {
        throw new Error(`Unsupported package manager "${requested}". Use npm, pnpm, yarn, or bun.`)
      }

      const current = getCliVersion()
      const latest = latestPublishedVersion()
      const binPath = resolveLannrBin()
      const manager = managerFor(binPath, requested)
      const command = commandText(manager)
      const result = { package: PACKAGE_NAME, current, latest, binPath, manager: manager.name, command }

      if (opts.json) {
        console.log(JSON.stringify({ ...result, dryRun: Boolean(opts.dryRun), upToDate: current === latest }, null, 2))
        if (opts.dryRun || current === latest) return
      } else {
        if (opts.dryRun) {
          console.log(`Current version: ${current}`)
          console.log(`Latest version:  ${latest}`)
          console.log(`Would run: ${command}`)
          return
        }
        if (current === latest) {
          console.log(`Lannr CLI is already up to date (${current}).`)
          return
        }
        console.log(`Updating Lannr CLI from ${current} to ${latest} via ${manager.name}.`)
        console.log(`Running: ${command}`)
      }
      const update = runUpdate(manager)
      if (update.error) throw new Error(`Could not run ${manager.name}: ${update.error.message}`)
      if (update.status !== 0) {
        process.exitCode = update.status ?? 1
        return
      }

      if (!opts.json) console.log(`Lannr CLI updated to ${latest}.`)
    })
}
