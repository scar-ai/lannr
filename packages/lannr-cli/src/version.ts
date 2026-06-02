import { readFileSync } from 'node:fs'

export function getCliVersion(): string {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
  return packageJson.version ?? '0.0.0'
}
