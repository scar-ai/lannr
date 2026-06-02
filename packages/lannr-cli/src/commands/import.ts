import { importFromHermes, type ImportOptions, type ImportSummary } from '../importers/hermes.js'
import { importFromOpenClaw } from '../importers/openclaw.js'

type Source = 'hermes' | 'openclaw'
type What = 'all' | 'providers' | 'agents'

const VALID_SOURCES: Source[] = ['hermes', 'openclaw']
const VALID_WHATS: What[] = ['all', 'providers', 'agents']

export function register(program) {
  program.command('import')
    .description('Import providers and/or agents from another agent platform')
    .argument('<source>', `source platform: ${VALID_SOURCES.join(' | ')}`)
    .argument('[what]', `what to import: ${VALID_WHATS.join(' | ')} (default: all)`, 'all')
    .option('--source-path <path>', 'override config root (default: ~/.hermes or ~/.openclaw)')
    .option('--overwrite', 'overwrite existing providers/agents')
    .option('--dry-run', 'show what would be imported without writing')
    .option('--include-secrets', 'copy inline API keys when found (hermes only)')
    .option('--no-set-primary', 'do not change the primary provider')
    .option('--json', 'output JSON summary')
    .action(async (source: string, what: string, opts: any) => {
      const normalizedSource = String(source).trim().toLowerCase() as Source
      const normalizedWhat = String(what || 'all').trim().toLowerCase() as What
      if (!VALID_SOURCES.includes(normalizedSource)) {
        console.error(`Invalid source "${source}". Expected one of: ${VALID_SOURCES.join(', ')}`)
        process.exitCode = 1
        return
      }
      if (!VALID_WHATS.includes(normalizedWhat)) {
        console.error(`Invalid scope "${what}". Expected one of: ${VALID_WHATS.join(', ')}`)
        process.exitCode = 1
        return
      }

      const options: ImportOptions = {
        source: opts.sourcePath,
        overwrite: Boolean(opts.overwrite),
        dryRun: Boolean(opts.dryRun),
        includeSecrets: Boolean(opts.includeSecrets),
        setPrimary: opts.setPrimary !== false,
        json: Boolean(opts.json),
      }

      const summary = normalizedSource === 'hermes'
        ? await importFromHermes(normalizedWhat, options)
        : await importFromOpenClaw(normalizedWhat, options)

      if (opts.json) {
        console.log(JSON.stringify(summary, null, 2))
        return
      }
      printSummary(summary, normalizedWhat, options)
    })
}

function printSummary(summary: ImportSummary, what: What, options: ImportOptions) {
  const verb = options.dryRun ? 'Plan' : 'Imported'
  console.log(`${verb} from ${summary.source} (${summary.hermesRoot})`)
  if (what === 'all' || what === 'providers') {
    if (summary.providers.length === 0) {
      console.log('  Providers: (none found)')
    } else {
      console.log('  Providers:')
      for (const row of summary.providers) {
        const tail = row.reason ? ` — ${row.reason}` : ''
        console.log(`    [${row.action}] ${row.id}${tail}`)
      }
    }
    if (summary.primaryProvider) {
      console.log(`  Primary: ${summary.primaryProvider}`)
    }
  }
  if (what === 'all' || what === 'agents') {
    if (summary.agents.length === 0) {
      console.log('  Agents: (none found)')
    } else {
      console.log('  Agents:')
      for (const row of summary.agents) {
        const tail = row.reason ? ` — ${row.reason}` : ''
        console.log(`    [${row.action}] ${row.id}${tail}`)
      }
    }
  }
  for (const note of summary.notes) console.log(`  note: ${note}`)
}
