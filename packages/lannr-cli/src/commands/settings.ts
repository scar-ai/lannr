import React from 'react'
import { render } from 'ink'
import { SETTING_DEFS, loadSettings, saveSettings, settingsPath } from '../settings.js'
import { SettingsTui } from '../ui/SettingsTui.js'
import { printTable } from '../cli/helpers.js'

export function register(program) {
  const settings = program.command('settings')
    .description('Open the Lannr settings UI')
    .action(async () => {
      if (!process.stdin.isTTY) {
        console.error('lannr settings requires an interactive terminal. Use `lannr settings list` or `lannr settings set <key> <value>` for headless use.')
        process.exitCode = 1
        return
      }
      const { waitUntilExit } = render(React.createElement(SettingsTui), { exitOnCtrlC: true })
      await waitUntilExit()
    })

  settings.command('list')
    .alias('ls')
    .description('List settings')
    .option('--json', 'print JSON')
    .action(async (opts) => {
      const stored = await loadSettings()
      const rows = SETTING_DEFS.map((def) => ({
        key: def.key,
        value: stored[def.key] ?? def.default,
        default: def.default,
        description: def.description,
      }))
      if (opts.json) {
        console.log(JSON.stringify({ path: settingsPath(), settings: rows }, null, 2))
        return
      }
      console.log(`Settings: ${settingsPath()}`)
      printTable(rows)
    })

  settings.command('get')
    .description('Print one setting value')
    .argument('<key>', 'setting key')
    .option('--json', 'print JSON')
    .action(async (key, opts) => {
      const def = requireSettingDef(key)
      const stored = await loadSettings()
      const value = stored[def.key] ?? def.default
      if (opts.json) console.log(JSON.stringify({ key: def.key, value }, null, 2))
      else console.log(value)
    })

  settings.command('set')
    .description('Set one setting value')
    .argument('<key>', 'setting key')
    .argument('<value>', 'setting value')
    .option('--json', 'print JSON')
    .action(async (key, value, opts) => {
      const def = requireSettingDef(key)
      const stored = await loadSettings()
      const next = { ...stored, [def.key]: parseSettingValue(def, value) }
      await saveSettings(next)
      if (opts.json) console.log(JSON.stringify({ key: def.key, value: next[def.key], path: settingsPath() }, null, 2))
      else console.log(`Set ${def.key}=${next[def.key]}`)
    })
}

function requireSettingDef(key) {
  const def = SETTING_DEFS.find((entry) => entry.key === key)
  if (!def) throw new Error(`Unknown setting "${key}". Valid settings: ${SETTING_DEFS.map((entry) => entry.key).join(', ')}`)
  return def
}

function parseSettingValue(def, value) {
  if (def.type === 'boolean') {
    const normalized = String(value).trim().toLowerCase()
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false
    throw new Error(`${def.key} must be a boolean value`)
  }
  if (def.type === 'number') {
    const parsed = Number(value)
    if (!Number.isInteger(parsed)) throw new Error(`${def.key} must be an integer`)
    const min = def.min ?? Number.MIN_SAFE_INTEGER
    const max = def.max ?? Number.MAX_SAFE_INTEGER
    if (parsed < min || parsed > max) throw new Error(`${def.key} must be between ${min} and ${max}`)
    return parsed
  }
  return value
}
