import type { ToolDefinition } from './types.js'

export function tool<T extends ToolDefinition>(definition: T): T {
  if (!definition.name || !/^[A-Za-z_$][\w$]*$/.test(definition.name)) {
    throw new Error(`Invalid tool name: ${definition.name}`)
  }
  if (!definition.input || !definition.output) {
    throw new Error(`Tool ${definition.name} must declare input and output schemas`)
  }
  return Object.freeze({ cacheTTL: 0, tags: [], ...definition }) as T
}
