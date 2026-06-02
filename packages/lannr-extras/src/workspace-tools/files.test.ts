import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileTools } from './files.js'

const temps = []

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'lannr-workspace-tools-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function fileTool(name, ctx) {
  const found = createFileTools(ctx).find((entry) => entry.name === name)
  if (!found) throw new Error(`missing tool: ${name}`)
  return found
}

describe('createFileTools', () => {
  it('lets non-global agents read files from configured read-only roots', async () => {
    const workspace = await tempDir()
    const skillRoot = await tempDir()
    const skillFile = join(skillRoot, 'SKILL.md')
    await writeFile(skillFile, '# Skill\n', 'utf8')

    const read = fileTool('readFile', { workspace, agent: {}, globalReach: false, readOnlyRoots: [skillRoot] })
    const result = await read.handler({ path: skillFile, maxChars: 10_000 }) as unknown as { path: string; content: string }

    expect(result.path).toBe(skillFile)
    expect(result.content).toBe('# Skill\n')
  })

  it('keeps read-only roots unavailable to writeFile', async () => {
    const workspace = await tempDir()
    const skillRoot = await tempDir()
    const skillFile = join(skillRoot, 'SKILL.md')

    const write = fileTool('writeFile', { workspace, agent: {}, globalReach: false, readOnlyRoots: [skillRoot] })

    await expect(write.handler({ path: skillFile, content: '# Changed\n' })).rejects.toThrow('Path escapes workspace')
    await expect(readFile(skillFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
