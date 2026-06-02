import { on, onWebhook, schedule } from 'lannr-extras/scheduler'
import { createAgentRuntime } from '../agents/runtime.js'
import { agentSchedulerDir, createAgentReactiveRoutineStore } from '../scheduler/store.js'
import {
  formatTrigger,
  parseFutureDate,
  parseJsonOption,
  parseSinkOption,
  printTable,
  resolveRoutineId,
  resolveSchedulerCommandRuntime,
} from '../cli/helpers.js'

export function register(program) {
  const reactive = program.command('reactive').alias('scheduler').description('Manage reactive routines')

  reactive.command('list')
    .alias('ls')
    .description('List reactive routines')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .option('--json', 'print JSON')
    .action(async (opts) => {
      const { agent, store } = await resolveSchedulerCommandRuntime(opts.agent)
      const rows = await store.list()
      if (opts.json) {
        console.log(JSON.stringify({ agent: agent.id, schedulerDir: agentSchedulerDir(agent), routines: rows }, null, 2))
        return
      }
      console.log(`Agent: ${agent.id}`)
      console.log(`Scheduler: ${agentSchedulerDir(agent)}`)
      if (rows.length === 0) {
        console.log('No reactive routines configured.')
        return
      }
      printTable(rows.map((row) => ({
        id: row.id,
        enabled: row.enabled ? 'yes' : 'no',
        trigger: formatTrigger(row.trigger),
        routine: row.routineId,
        status: row.lastRunStatus ?? '',
        failures: row.consecutiveFailures,
        nextRunAt: row.nextRunAt?.toISOString?.() ?? '',
      })))
    })

  reactive.command('cron')
    .description('Create or replace a cron-triggered routine')
    .argument('<name>', 'reactive routine id')
    .requiredOption('--cron <expr>', 'five-field cron expression')
    .requiredOption('--routine <routine>', 'saved routine id or name')
    .requiredOption('--input <json>', 'JSON input passed to the routine')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .option('--sink <json>', 'sink JSON; defaults to {"type":"store"}')
    .option('--failure-threshold <n>', 'disable after this many consecutive failures')
    .action(async (name, opts) => {
      const runtime = await createAgentRuntime({ agentId: opts.agent })
      const store = createAgentReactiveRoutineStore(runtime.agent)
      const routineId = await resolveRoutineId(runtime.memory, opts.routine)
      const reactiveRoutine = schedule(name, {
        cron: opts.cron,
        routine: routineId,
        input: parseJsonOption(opts.input, '--input'),
        sink: parseSinkOption(opts.sink),
        failureThreshold: opts.failureThreshold ? Number(opts.failureThreshold) : undefined,
      })
      await store.save(reactiveRoutine)
      console.log(JSON.stringify(reactiveRoutine, null, 2))
    })

  reactive.command('once')
    .description('Create or replace a one-time routine schedule')
    .argument('<name>', 'reactive routine id')
    .requiredOption('--run-at <time>', 'future timestamp parseable by JavaScript Date')
    .requiredOption('--routine <routine>', 'saved routine id or name')
    .option('--input <json>', 'JSON input passed to the routine', '{}')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .option('--sink <json>', 'sink JSON; defaults to {"type":"store"}')
    .option('--failure-threshold <n>', 'disable after this many consecutive failures')
    .action(async (name, opts) => {
      const runtime = await createAgentRuntime({ agentId: opts.agent })
      const store = createAgentReactiveRoutineStore(runtime.agent)
      const routineId = await resolveRoutineId(runtime.memory, opts.routine)
      const runAt = parseFutureDate(opts.runAt, '--run-at')
      const reactiveRoutine = {
        id: name,
        name,
        routineId,
        trigger: { type: 'once', runAt: runAt.toISOString() },
        input: parseJsonOption(opts.input, '--input'),
        sink: parseSinkOption(opts.sink),
        enabled: true,
        lastRunAt: null,
        lastRunStatus: null,
        consecutiveFailures: 0,
        failureThreshold: opts.failureThreshold ? Number(opts.failureThreshold) : 5,
        nextRunAt: runAt,
        catchUp: false,
        createdAt: new Date(),
      }
      await store.save(reactiveRoutine)
      console.log(JSON.stringify(reactiveRoutine, null, 2))
    })

  reactive.command('event')
    .description('Create or replace an event-triggered routine')
    .argument('<name>', 'reactive routine id')
    .requiredOption('--event <event>', 'event name')
    .requiredOption('--routine <routine>', 'saved routine id or name')
    .requiredOption('--input-mapper <source>', 'pure mapper source, e.g. "(event) => ({ value: event.value })"')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .option('--sink <json>', 'sink JSON; defaults to {"type":"store"}')
    .option('--failure-threshold <n>', 'disable after this many consecutive failures')
    .action(async (name, opts) => {
      const runtime = await createAgentRuntime({ agentId: opts.agent })
      const store = createAgentReactiveRoutineStore(runtime.agent)
      const routineId = await resolveRoutineId(runtime.memory, opts.routine)
      const reactiveRoutine = on(name, {
        event: opts.event,
        routine: routineId,
        inputMapper: opts.inputMapper,
        sink: parseSinkOption(opts.sink),
        failureThreshold: opts.failureThreshold ? Number(opts.failureThreshold) : undefined,
      })
      await store.save(reactiveRoutine)
      console.log(JSON.stringify(reactiveRoutine, null, 2))
    })

  reactive.command('webhook')
    .description('Create or replace a webhook-triggered routine')
    .argument('<name>', 'reactive routine id')
    .requiredOption('--routine <routine>', 'saved routine id or name')
    .requiredOption('--input-mapper <source>', 'pure mapper source, e.g. "(event) => ({ value: event.value })"')
    .requiredOption('--secret <secret>', 'webhook secret')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .option('--sink <json>', 'sink JSON; defaults to {"type":"store"}')
    .option('--failure-threshold <n>', 'disable after this many consecutive failures')
    .action(async (name, opts) => {
      const runtime = await createAgentRuntime({ agentId: opts.agent })
      const store = createAgentReactiveRoutineStore(runtime.agent)
      const routineId = await resolveRoutineId(runtime.memory, opts.routine)
      const reactiveRoutine = onWebhook(name, {
        routine: routineId,
        inputMapper: opts.inputMapper,
        secret: opts.secret,
        sink: parseSinkOption(opts.sink),
        failureThreshold: opts.failureThreshold ? Number(opts.failureThreshold) : undefined,
      })
      await store.save(reactiveRoutine)
      console.log(JSON.stringify(reactiveRoutine, null, 2))
    })

  reactive.command('run')
    .description('Run a reactive routine immediately')
    .argument('<name>', 'reactive routine id')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .option('--payload <json>', 'event/webhook payload JSON')
    .action(async (name, opts) => {
      const { scheduler } = await resolveSchedulerCommandRuntime(opts.agent)
      const result = await scheduler.runNow(name, opts.payload ? parseJsonOption(opts.payload, '--payload') : undefined)
      console.log(JSON.stringify({ id: name, result }, null, 2))
    })

  reactive.command('publish')
    .description('Publish a local event and execute matching event routines')
    .argument('<event>', 'event name')
    .requiredOption('--payload <json>', 'event payload JSON')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .action(async (event, opts) => {
      const { bus, scheduler } = await resolveSchedulerCommandRuntime(opts.agent)
      await (scheduler as any).subscribeToEvents()
      await bus.publish(event, parseJsonOption(opts.payload, '--payload'))
      scheduler.stop()
      console.log(JSON.stringify({ event, delivered: true }, null, 2))
    })

  reactive.command('handle-webhook')
    .description('Handle a webhook payload for a webhook-triggered routine')
    .argument('<name>', 'reactive routine id')
    .requiredOption('--payload <json>', 'webhook payload JSON')
    .requiredOption('--secret <secret>', 'webhook secret')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .action(async (name, opts) => {
      const { scheduler } = await resolveSchedulerCommandRuntime(opts.agent)
      const result = await scheduler.handleWebhook(name, parseJsonOption(opts.payload, '--payload'), opts.secret)
      console.log(JSON.stringify({ id: name, result }, null, 2))
    })

  reactive.command('enable')
    .description('Enable a reactive routine')
    .argument('<name>', 'reactive routine id')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .action(async (name, opts) => {
      const { store } = await resolveSchedulerCommandRuntime(opts.agent)
      await store.enable(name)
      console.log(`Enabled ${name}`)
    })

  reactive.command('disable')
    .description('Disable a reactive routine')
    .argument('<name>', 'reactive routine id')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .action(async (name, opts) => {
      const { store } = await resolveSchedulerCommandRuntime(opts.agent)
      await store.disable(name)
      console.log(`Disabled ${name}`)
    })

  reactive.command('rm')
    .alias('delete')
    .description('Remove a reactive routine')
    .argument('<name>', 'reactive routine id')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .action(async (name, opts) => {
      const { store } = await resolveSchedulerCommandRuntime(opts.agent)
      await store.delete(name)
      console.log(`Removed ${name}`)
    })

  reactive.command('start')
    .description('Start the in-process cron scheduler')
    .option('-a, --agent <agent>', 'agent id, name, or alias')
    .option('--poll-ms <ms>', 'poll interval in milliseconds', '10000')
    .action(async (opts) => {
      const { scheduler, agent } = await resolveSchedulerCommandRuntime(opts.agent, { pollMs: Number(opts.pollMs) })
      console.log(`Scheduler started for agent ${agent.id}. Press Ctrl-C to stop.`)
      process.once('SIGINT', () => {
        scheduler.stop()
        process.exit(0)
      })
      await scheduler.start()
    })
}
