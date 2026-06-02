import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { generateDiff } from 'lannr-core'
import { FileMemoryStore, rollbackRoutine } from './index.js'

describe('memory subsystems', () => {
  it('patches routines, records changelog, and rolls back', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lannr-memory-'))
    const store = new FileMemoryStore(dir)
    const before = 'const value = 1\nreturn value'
    const after = 'const value = 2\nreturn value'
    await store.save({
      id: 'routine-1',
      name: 'sample',
      description: 'sample routine',
      tags: [],
      input: z.unknown(),
      output: z.unknown(),
      program: before,
      trust: { level: 'provisional', runs: 0, successfulRuns: 0, successRate: 0 },
    })

    const patched = await store.patch('routine-1', { patch: generateDiff(before, after), reason: 'change value', expectedVersion: 1 })
    expect(patched.version).toBe(2)
    expect(patched.program).toBe(after)
    expect(patched.changelog.at(-1)?.outcome).toBe('success')

    const rolledBack = await rollbackRoutine(store, 'routine-1', 1)
    expect(rolledBack.version).toBe(3)
    expect(rolledBack.program).toBe(before)
    expect(rolledBack.changelog.at(-1)?.outcome).toBe('rolled-back')
  })

  it('saves failed diffs and rejects version conflicts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lannr-memory-'))
    const store = new FileMemoryStore(dir)
    await store.save({
      id: 'routine-2',
      name: 'sample',
      description: 'sample routine',
      tags: [],
      input: z.unknown(),
      output: z.unknown(),
      program: 'return 1',
      trust: { level: 'provisional', runs: 0, successfulRuns: 0, successRate: 0 },
    })

    await expect(store.patch('routine-2', { patch: '--- a/routine\n+++ b/routine\n@@ -1,1 +1,1 @@\n-return 2\n+return 3', reason: 'bad context', expectedVersion: 1 })).rejects.toThrow(/Patch did not apply/)
    expect((await store.get('routine-2'))?.changelog.at(-1)?.outcome).toBe('failure')
    await expect(store.patch('routine-2', { patch: 'return 4', reason: 'conflict', expectedVersion: 1 })).rejects.toThrow(/version conflict/)
  })

  it('progresses routine trust from draft through provisional to trusted', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lannr-memory-'))
    const store = new FileMemoryStore(dir)
    await store.save({
      id: 'routine-3',
      name: 'sample',
      description: 'sample routine',
      tags: [],
      input: z.unknown(),
      output: z.unknown(),
      program: 'return 1',
      trust: { level: 'draft', runs: 0, successfulRuns: 0, successRate: 0 },
    })

    for (let i = 0; i < 5; i++) await store.recordRun('routine-3', true)
    expect((await store.get('routine-3'))?.trust.level).toBe('provisional')

    for (let i = 5; i < 50; i++) await store.recordRun('routine-3', true)
    expect((await store.get('routine-3'))?.trust.level).toBe('trusted')
  })

  it('records failed patch validation before commit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lannr-memory-'))
    const store = new FileMemoryStore(dir)
    await store.save({
      id: 'routine-4',
      name: 'sample',
      description: 'sample routine',
      tags: [],
      input: z.unknown(),
      output: z.unknown(),
      program: 'return 1',
      trust: { level: 'draft', runs: 0, successfulRuns: 0, successRate: 0 },
    })

    await expect(store.patch('routine-4', { patch: 'return 2', reason: 'trial', trialRun: () => { throw new Error('trial failed') } })).rejects.toThrow(/trial failed/)
    const routine = await store.get('routine-4')
    expect(routine?.program).toBe('return 1')
    expect(routine?.changelog.at(-1)?.outcome).toBe('failure')
  })
})
