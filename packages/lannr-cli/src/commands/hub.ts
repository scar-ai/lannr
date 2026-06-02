import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { startServer } from '../server.js'

function hubDir() {
  const root = process.env.LANNR_HOME ?? resolve(homedir(), '.lannr')
  return resolve(root, 'hub')
}

function pidFile() {
  return join(hubDir(), 'hub.pid')
}

function logFile() {
  return join(hubDir(), 'hub.log')
}

function readPid(): number | null {
  try {
    const pid = Number(readFileSync(pidFile(), 'utf8').trim())
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

function clearPidFile() {
  try { unlinkSync(pidFile()) } catch {}
}

function serverOverrides(opts: Record<string, any>) {
  return {
    port: opts.port ? Number(opts.port) : undefined,
    host: opts.host,
    model: opts.model,
    baseURL: opts.baseUrl,
    apiKey: opts.apiKey,
  }
}

export function register(program) {
  const hub = program.command('hub').alias('gateway').description('Run and manage the Lannr agent hub')

  hub.command('start')
    .alias('run')
    .description('Start the Lannr hub server in the background (survives terminal close)')
    .option('-p, --port <port>', 'port to listen on')
    .option('--host <host>', 'host to bind')
    .option('-m, --model <model>', 'default model name')
    .option('--base-url <url>', 'OpenAI-compatible model API base URL')
    .option('--api-key <key>', 'model API key; defaults to LANNR_API_KEY or OPENAI_API_KEY')
    .option('-f, --foreground', 'run in the foreground and stream logs to this terminal')
    .action(async (opts) => {
      // The detached child is launched with --foreground; it runs the actual server.
      if (opts.foreground) {
        if (process.env.LANNR_HUB_DAEMON === '1') {
          process.once('exit', clearPidFile)
        }
        await startServer(serverOverrides(opts))
        return
      }

      const existing = readPid()
      if (existing && isRunning(existing)) {
        console.log(`Lannr hub already running (pid ${existing}). Use "lannr hub stop" to stop it.`)
        return
      }
      if (existing) clearPidFile()

      mkdirSync(hubDir(), { recursive: true })
      const log = openSync(logFile(), 'a')

      const args = [process.argv[1], 'hub', 'start', '--foreground']
      if (opts.port) args.push('--port', String(opts.port))
      if (opts.host) args.push('--host', opts.host)
      if (opts.model) args.push('--model', opts.model)
      if (opts.baseUrl) args.push('--base-url', opts.baseUrl)
      if (opts.apiKey) args.push('--api-key', opts.apiKey)

      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: ['ignore', log, log],
        env: { ...process.env, LANNR_HUB_DAEMON: '1' },
      })
      child.unref()

      if (child.pid) writeFileSync(pidFile(), String(child.pid))
      console.log(`Lannr hub started in background (pid ${child.pid}).`)
      console.log(`Logs: ${logFile()}`)
      console.log(`Stop with: lannr hub stop`)
    })

  hub.command('stop')
    .description('Stop the background Lannr hub server')
    .action(() => {
      const pid = readPid()
      if (!pid) {
        console.log('Lannr hub is not running.')
        return
      }
      if (!isRunning(pid)) {
        clearPidFile()
        console.log('Lannr hub is not running (cleared stale pid file).')
        return
      }
      try {
        process.kill(pid, 'SIGTERM')
      } catch (error: any) {
        console.error(`Failed to stop Lannr hub (pid ${pid}): ${error?.message ?? error}`)
        return
      }
      clearPidFile()
      console.log(`Lannr hub stopped (pid ${pid}).`)
    })

  hub.command('status')
    .description('Show whether the background Lannr hub is running')
    .action(() => {
      const pid = readPid()
      if (pid && isRunning(pid)) {
        console.log(`Lannr hub is running (pid ${pid}).`)
        console.log(`Logs: ${logFile()}`)
        return
      }
      if (pid) clearPidFile()
      console.log('Lannr hub is not running.')
    })
}
