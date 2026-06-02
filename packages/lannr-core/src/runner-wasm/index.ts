import type { ExecOptions, ToolBindings, VaultRunner } from '../core/index.js'

export function wasmRunner(): VaultRunner {
  return {
    async execute(program: string, bindings: ToolBindings, _opts: ExecOptions): Promise<unknown> {
      const names = Object.keys(bindings)
      const values = Object.values(bindings)
      const fn = new Function(...names, `"use strict"; return (async () => {\n${program}\n})()`)
      return await fn(...values)
    },
  }
}
