import vm from 'node:vm'
import type { ExecOptions, ToolBindings, VaultRunner } from '../core/index.js'

export interface NodeRunnerOptions {
  timeout?: number
  timeoutMs?: number
  memoryLimitMb?: number
}

export function nodeRunner(defaults: NodeRunnerOptions = {}): VaultRunner {
  return {
    async execute(program: string, bindings: ToolBindings, opts: ExecOptions): Promise<unknown> {
      const timeoutMs = opts.timeoutMs ?? defaults.timeoutMs ?? defaults.timeout ?? 30_000
      const context = vm.createContext({
        ...bindings,
        Promise,
        Array,
        Object,
        String,
        Number,
        Boolean,
        Date,
        JSON,
        Math,
        Set,
        Map,
        URL,
        URLSearchParams,
        console: Object.freeze({ log: () => undefined, warn: () => undefined, error: () => undefined }),
      }, {
        codeGeneration: { strings: false, wasm: false },
      })
      const wrapped = `(async () => {\n${returnFinalExpression(program)}\n})()`
      const script = new vm.Script(wrapped, { filename: 'lannr-vault.js' })
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          script.runInContext(context, { timeout: timeoutMs }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Vault execution timed out after ${timeoutMs}ms`)), timeoutMs)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}

function returnFinalExpression(program: string): string {
  if (/\breturn\b/.test(program)) return program
  const lines = program.split('\n')
  let index = lines.length - 1
  while (index >= 0 && !lines[index]?.trim()) index--
  if (index < 0) return program

  const line = lines[index]!.trim()
  if (!line || line.startsWith('//') || /^(const|let|var|if|for|while|switch|try|catch|finally|function|class)\b/.test(line)) return program
  if (line.endsWith('{') || line.endsWith('}')) return program

  lines[index] = `${lines[index]!.slice(0, lines[index]!.length - lines[index]!.trimStart().length)}return ${line.replace(/;$/, '')}`
  return lines.join('\n')
}
