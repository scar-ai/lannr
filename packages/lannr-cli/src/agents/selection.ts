export function selectSpawnAgent(agents, { currentAgentId, requestedAgent, task, context }) {
  if (requestedAgent) {
    const normalized = normalizeAgentRef(requestedAgent)
    const agent = agents.find((entry) => {
      return entry.id === normalized ||
        normalizeAgentRef(entry.name) === normalized ||
        (entry.aliases ?? []).some((alias) => normalizeAgentRef(alias) === normalized)
    })
    return agent
      ? { agent, selectedBy: 'requested' }
      : { agent: null, error: `Agent not found: ${requestedAgent}` }
  }

  const candidates = agents.filter((entry) => entry.id !== currentAgentId)
  if (!candidates.length) return { agent: null, error: 'No other user-created agents are available to spawn.' }

  const queryTokens = tokenSet(`${task} ${context}`)
  const ranked = candidates
    .map((entry) => ({
      agent: entry,
      score: scoreAgentForTask(entry, queryTokens),
    }))
    .sort((left, right) => right.score - left.score || left.agent.id.localeCompare(right.agent.id))

  return { agent: ranked[0].agent, selectedBy: 'description-match' }
}

export function scoreAgentForTask(agent, queryTokens) {
  const weightedText = [
    agent.name,
    agent.name,
    ...(agent.aliases ?? []),
    agent.description,
    agent.description,
    agent.instructions,
  ].join(' ')
  const agentTokens = tokenSet(weightedText)
  let score = 0
  for (const token of queryTokens) {
    if (agentTokens.has(token)) score += token.length > 4 ? 2 : 1
  }
  if (agent.default) score -= 0.5
  return score
}

export function buildSpawnPrompt({ parent, child, task, context }) {
  return [
    `You were spawned by Lannr agent "${parent.name}" (${parent.id}) because your configured specialization appears relevant.`,
    `Your agent identity: ${child.name} (${child.id}).`,
    child.description ? `Your description: ${child.description}` : '',
    'Work only on the delegated task below. Return a concise final answer with findings, changes, or blockers.',
    'Do not call spawnAgent; spawned agents are leaf workers in this runtime.',
    '',
    'Task:',
    task,
    context ? `\nContext:\n${context}` : '',
  ].filter(Boolean).join('\n')
}

export function tokenSet(value) {
  return new Set(String(value ?? '').toLowerCase().match(/[a-z0-9._-]{3,}/g) ?? [])
}

export function normalizeAgentRef(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}
