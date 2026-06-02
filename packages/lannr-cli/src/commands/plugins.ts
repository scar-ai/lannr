import { resolve as resolvePath } from 'node:path'
import {
  addPluginRegistryEntry,
  listAvailablePlugins,
  pluginsHome,
  pluginsRegistryPath,
  removePluginRegistryEntry,
} from '../plugins/loader.js'
import { printTable } from '../cli/helpers.js'

export function register(program) {
  const plugins = program.command('plugins').description('Manage Lannr tool plugins')

  plugins.command('list')
    .alias('ls')
    .description('List installed plugins')
    .option('--json', 'print JSON')
    .action(async (opts) => {
      const entries = await listAvailablePlugins()
      if (opts.json) {
        console.log(JSON.stringify({ registry: pluginsRegistryPath(), autoDir: pluginsHome(), plugins: entries }, null, 2))
        return
      }
      console.log(`Registry: ${pluginsRegistryPath()}`)
      console.log(`Auto-discovery: ${pluginsHome()}`)
      if (!entries.length) { console.log('No plugins installed.'); return }
      printTable(entries.map((entry) => ({ id: entry.id, path: entry.path, source: entry.auto ? 'auto' : 'registry' })))
    })

  plugins.command('add')
    .description('Register a plugin module')
    .argument('<path>', 'path to a JavaScript file exporting plugin tools')
    .option('--id <id>', 'plugin id; defaults to the file basename')
    .action(async (path, opts) => {
      const absolute = resolvePath(path)
      const id = opts.id ?? path.split('/').pop().replace(/\.(js|mjs)$/i, '')
      const saved = await addPluginRegistryEntry({ id, path: absolute })
      console.log(`Plugin "${saved.id}" registered (${saved.path}).`)
    })

  plugins.command('rm')
    .alias('remove')
    .description('Remove a plugin from the registry')
    .argument('<id>', 'plugin id')
    .action(async (id) => {
      const removed = await removePluginRegistryEntry(id)
      if (!removed) {
        console.error(`Plugin not found: ${id}`)
        process.exitCode = 1
        return
      }
      console.log(`Plugin "${id}" removed from registry.`)
    })
}
