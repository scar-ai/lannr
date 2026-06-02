import type { ExecOptions, ToolBindings, VaultRunner } from '../core/index.js'

export interface EdgeRunnerOptions {
  endpoint: string
  headers?: Record<string, string>
}

export function edgeRunner(options: EdgeRunnerOptions): VaultRunner {
  return {
    async execute(program: string, _bindings: ToolBindings, opts: ExecOptions): Promise<unknown> {
      const res = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify({ program, opts, bindings: Object.keys(_bindings) }),
      })
      if (!res.ok) throw new Error(`Edge runner failed: ${res.status} ${await res.text()}`)
      return (await res.json()).result
    },
  }
}
