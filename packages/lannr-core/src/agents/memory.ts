import { resolve } from 'node:path'

// The memory-backed agent store (`createAgentMemoryStore`) lives in
// `lannr-extras` because it depends on `FileMemoryStore`. This module keeps
// only the pure path helper so `lannr-core` stays free of extras deps.
export function agentMemoryDir(agent) {
  return resolve(agent.agentDir, 'memory')
}
