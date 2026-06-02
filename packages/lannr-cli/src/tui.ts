import { access } from 'node:fs/promises';
import React from 'react';
import { render } from 'ink';
import { ChatApp } from './ui/ChatApp.js';
import { loadConfig } from './config.js';
import { generateSessionId, loadLastSessionId, saveLastSessionId, sessionPath } from './agents/sessions.js';
import { listAgents, loadLastAgentId, resolveDefaultAgent, saveLastAgentId } from './agents/registry.js';

export async function runTui(opts: Record<string, any> = {}) {
  if (!process.stdin.isTTY) {
    // Fall back to non-interactive streaming for piped input
    const { runAgentPrompt } = await import('./agents/runtime.js');
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const prompt = Buffer.concat(chunks).toString('utf8').trim() || opts.message?.trim();
    if (prompt) {
      await runAgentPrompt({
        agentId: opts.agent,
        prompt,
        session: opts.session,
        stream: true,
        overrides: {
          ...(opts.provider ? { provider: opts.provider } : {}),
          ...(opts.model ? { model: opts.model } : {}),
        },
      });
    }
    return;
  }

  let resolved;
  try {
    resolved = await resolveStartupTarget(opts);
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
    return;
  }

  let currentSession = resolved.sessionId;
  let currentAgent = resolved.agent.id;
  await saveLastAgentId(currentAgent);

  let interrupted = false;
  const { waitUntilExit } = render(
    React.createElement(ChatApp, {
      agent: resolved.agent.id,
      provider: opts.provider,
      model: opts.model,
      session: resolved.sessionId,
      message: opts.message,
      historyLimit: opts.historyLimit ?? '200',
      tools: opts.tools,
      thinking: opts.thinking,
      onSessionChange: (session, agentId) => {
        currentSession = session;
        if (agentId) {
          currentAgent = agentId;
          saveLastAgentId(agentId).catch(() => {});
        }
      },
      onInterrupt: (session, agent) => {
        interrupted = true;
        currentSession = session;
        currentAgent = agent ?? currentAgent;
      },
    }),
    { exitOnCtrlC: false }
  );

  await waitUntilExit();
  if (interrupted) {
    await rememberLastSession(currentAgent, currentSession);
    await saveLastAgentId(currentAgent);
    console.log(`Session: ${currentSession}`);
    console.log(`Resume with: lannr resume ${currentSession}`);
  }
}

async function resolveStartupTarget(opts) {
  const config = await loadConfig();
  const registered = await listAgents();
  if (!registered.length) {
    throw new Error('No agents configured. Add one with `lannr agents add` before running `lannr chat`.');
  }

  // Explicit --agent flag wins; fall back to last-used, then default.
  let agent = opts.agent ? findAgentInConfig(config, opts.agent) : null;
  if (opts.agent && !agent) {
    throw new Error(`Agent not found: ${opts.agent}`);
  }

  if (!agent) {
    const lastAgentId = await loadLastAgentId();
    if (lastAgentId) agent = findAgentInConfig(config, lastAgentId);
  }

  if (!agent) {
    agent = resolveDefaultAgent(registered) ?? registered[0];
    agent = findAgentInConfig(config, agent.id) ?? agent;
  }

  let sessionId = opts.session ? String(opts.session) : null;
  if (!sessionId) {
    const lastSessionId = await loadLastSessionId(agent);
    if (lastSessionId && await sessionFileExists(agent, lastSessionId)) {
      sessionId = lastSessionId;
    }
  }
  if (!sessionId) {
    sessionId = generateSessionId();
    await saveLastSessionId(agent, sessionId);
  }

  return { agent, sessionId };
}

function findAgentInConfig(config, key) {
  if (!key) return null;
  const lowered = String(key).toLowerCase();
  return config.agents[key] ?? Object.values(config.agents).find((entry) => (
    entry.id === key
    || entry.name?.toLowerCase() === lowered
    || entry.aliases?.some((alias) => String(alias).toLowerCase() === lowered)
  )) ?? null;
}

async function sessionFileExists(agent, sessionId) {
  try {
    await access(sessionPath(agent, sessionId));
    return true;
  } catch {
    return false;
  }
}

async function rememberLastSession(agentId, sessionId) {
  if (!sessionId) return;
  const config = await loadConfig();
  const agent = findAgentInConfig(config, agentId ?? config.defaultAgentId);
  if (agent) await saveLastSessionId(agent, sessionId);
}
