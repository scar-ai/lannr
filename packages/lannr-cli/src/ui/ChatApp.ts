import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useInput, Static } from 'ink';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLannrGateway } from '../gateway.js';
import { createAgentRuntime } from '../agents/runtime.js';
import { instructionFiles } from '../agents/prompt.js';
import { buildSkillsPrompt, listSkills } from '../agents/skills.js';
import { estimateTokens } from '../agents/trajectory.js';
import { countTokens } from '../llm/model-adapter.js';
import { InputBar } from './InputBar.js';
import { ClarifyPrompt } from './ClarifyPrompt.js';
import { loadConfig } from '../config.js';
import { generateSessionId, listSessions, loadLastSessionId, loadSession, normalizeSessionId, saveLastSessionId, saveSession, zeroUsage } from '../agents/sessions.js';
import { loadTodos } from '../agents/tools/todo.js';
import { clarifyBus } from '../agents/clarify-bus.js';
import { formatRateStateCompact } from '../llm/rate-limits.js';
import { createCheckpointManager } from '../safety/checkpoint.js';
import { buildUserContent, extractImagePaths } from '../agents/image-input.js';
import { Markdown } from './Markdown.js';
import { SessionsMenu } from './SessionsMenu.js';
import { AgentsMenu } from './AgentsMenu.js';
import { ModelsMenu } from './ModelsMenu.js';
import { startHubScheduler } from '../scheduler/manager.js';

const h = React.createElement;

const IMAGE_LABEL_RE = /\[Image #(\d+)\]/g;

const SLASH_COMMANDS = [
  { cmd: '/help',      desc: 'Show available commands' },
  { cmd: '/status',   desc: 'Show current status' },
  { cmd: '/context',  desc: 'Show token usage breakdown for the context window' },
  { cmd: '/agent',    desc: 'Browse agents and resume their last session' },
  { cmd: '/model',    desc: 'Switch the active model' },
  { cmd: '/provider', desc: 'Set provider override' },
  { cmd: '/sessions', desc: 'Browse and resume past sessions for this agent' },
  { cmd: '/new',      desc: 'Start a new session' },
  { cmd: '/history',  desc: 'Show chat history' },
  { cmd: '/compact',  desc: 'Summarize the conversation history now' },
  { cmd: '/tools',    desc: 'Toggle tool output' },
  { cmd: '/thinking', desc: 'Toggle thinking output' },
  { cmd: '/undo',     desc: 'Restore the workspace to the last checkpoint' },
  { cmd: '/clear',    desc: 'Clear the screen' },
  { cmd: '/exit',     desc: 'Exit Lannr TUI' },
];

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Same ~4-chars-per-token heuristic the trajectory/context engine uses, so the
// /context breakdown lines up with the budgets those systems enforce.
function estimateStringTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

// Horizontal usage bar for the /context breakdown. `pct` is 0–100.
function usageBar(pct, width = 22) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatCacheTokens(tokens) {
  if (!tokens) return '';
  return ` · cache:${formatTokens(tokens.cacheReadTokens)} write:${formatTokens(tokens.cacheWriteTokens)}`;
}

// Cache hit rate = cacheReadTokens / (inputTokens + cacheReadTokens). Anthropic
// usage reports inputTokens as *uncached* input, so cache reads are additive.
// OpenAI inputTokens *includes* cached, so we approximate hit rate as
// cached / inputTokens, which is close enough for a footer signal.
function formatCacheHitPct(tokens) {
  if (!tokens) return '';
  const read = tokens.cacheReadTokens ?? 0;
  if (!read) return '';
  const input = tokens.inputTokens ?? 0;
  const denominator = input >= read ? input : input + read;
  if (denominator <= 0) return '';
  const pct = Math.round((read / denominator) * 100);
  return ` · hit ${pct}%`;
}

// Total prompt tokens actually occupying the window on a single request.
// Anthropic reports inputTokens as *uncached* (cache reads are additive);
// OpenAI includes cached reads inside inputTokens. cacheWrite is part of the
// processed prompt either way. This is the ground-truth window occupancy.
function promptOccupancy(usage) {
  if (!usage) return 0;
  const input = usage.inputTokens ?? 0;
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const base = input >= read ? input : input + read;
  return base + write;
}

// Best-effort context-window sizes by model family. No per-model metadata
// exists in config, so these are maintained here; `approx` flags guesses.
function modelContextWindow(model) {
  const m = String(model || '').toLowerCase();
  if (/gemini/.test(m)) return { limit: 1_000_000, approx: true };
  if (/gpt-4\.1/.test(m)) return { limit: 1_000_000, approx: false };
  if (/gpt-5|codex/.test(m)) return { limit: 400_000, approx: true };
  if (/(^|[^a-z])o[1345]([^a-z]|$)/.test(m)) return { limit: 200_000, approx: false };
  if (/gpt-4o|gpt-4-turbo/.test(m)) return { limit: 128_000, approx: false };
  if (/gpt-4/.test(m)) return { limit: 128_000, approx: true };
  if (/gpt-3\.5/.test(m)) return { limit: 16_385, approx: false };
  if (/claude/.test(m)) return { limit: 200_000, approx: false };
  return { limit: 200_000, approx: true };
}

function trimHistory(arr, limit) {
  while (arr.length > limit) arr.shift();
}

function itemsFromMessages(messages) {
  return messages
    .filter(msg => msg.role === 'user' || msg.role === 'assistant')
    .map((msg, index) => ({
      type: msg.role === 'user' ? 'user' : 'assistant',
      id: `${msg.role}-${Date.now()}-${index}`,
      content: msg.content,
    }));
}

function splitUserContent(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: String(content ?? ''), images: [] };
  const textParts = [];
  const images = [];
  for (const part of content) {
    if (typeof part === 'string') textParts.push(part);
    else if (part?.type === 'text') textParts.push(part.text ?? '');
    else if (part?.type === 'image') images.push(part);
  }
  return { text: textParts.join(' ').trim(), images };
}

function stripImageLabels(text) {
  return String(text ?? '').replace(IMAGE_LABEL_RE, ' ').replace(/[ \t]+/g, ' ').trim();
}

function textWithImageLabels(text, attachments) {
  return [stripImageLabels(text), ...attachments.map((attachment) => attachment.label)].filter(Boolean).join(' ');
}

function nextImageLabelId(attachments) {
  let max = 0;
  for (const attachment of attachments) {
    const match = IMAGE_LABEL_RE.exec(attachment.label);
    IMAGE_LABEL_RE.lastIndex = 0;
    if (match) max = Math.max(max, Number(match[1]) || 0);
  }
  return max + 1;
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

// ─── Static item components ───────────────────────────────────────────────────

function ItemHeader() {
  return h(Box, { flexDirection: 'column', marginTop: 1, marginBottom: 1 },
    h(Box, null,
      h(Text, { color: 'cyan', bold: true }, '⬡ Lannr'),
      h(Text, { color: 'gray' }, '  local agent runtime')
    ),
    h(Box, { marginTop: 0 },
      h(Text, { color: 'gray' }, 'Type '),
      h(Text, { color: 'cyan' }, '/help'),
      h(Text, { color: 'gray' }, ' for commands · '),
      h(Text, { color: 'cyan' }, '!cmd'),
      h(Text, { color: 'gray' }, ' for shell · '),
      h(Text, { color: 'cyan' }, 'esc'),
      h(Text, { color: 'gray' }, ' to stop turn · '),
      h(Text, { color: 'cyan' }, '/exit'),
      h(Text, { color: 'gray' }, ' to quit · drag images in')
    ),
    h(Box, { marginTop: 0 },
      h(Text, { color: 'gray', dimColor: true }, '─'.repeat(58))
    )
  );
}

function ItemUser({ content }) {
  const { text, images } = splitUserContent(content);
  return h(Box, { flexDirection: 'column', marginTop: 1 },
    h(Box, null,
      h(Text, { color: 'cyan', bold: true }, 'You'),
      h(Text, { color: 'gray' }, ' › '),
      h(Text, { wrap: 'wrap' }, text || (images.length ? '(image only)' : ''))
    ),
    ...images.map((img, i) => h(Box, { key: `img-${i}`, paddingLeft: 6 },
      h(Text, { color: 'magenta' }, '↳ '),
      h(Text, { color: 'gray' }, `image: ${img.filename ?? img.source ?? 'attachment'}`)
    ))
  );
}

function ItemAssistant({ content }) {
  return h(Box, { flexDirection: 'column', marginBottom: 1 },
    h(Box, null,
      h(Text, { color: 'magenta', bold: true }, '◆'),
      h(Text, { color: 'gray' }, ' Lannr')
    ),
    h(Box, { paddingLeft: 2 },
      h(Markdown, null, content)
    )
  );
}

function ItemToolCall({ tool, input }) {
  const args = safeJson(input);
  const preview = args.length > 72 ? args.slice(0, 72) + '…' : args;
  return h(Box, { paddingLeft: 2 },
    h(Text, { color: 'yellow' }, '⟳ '),
    h(Text, { color: 'yellow', bold: true }, tool),
    h(Text, { color: 'gray' }, `  ${preview}`)
  );
}

function ItemToolResult({ tool, durationMs }) {
  return h(Box, { paddingLeft: 2 },
    h(Text, { color: 'green' }, '↳ '),
    h(Text, { color: 'gray' }, `${tool}  ok  ${durationMs}ms`)
  );
}

function ItemToolError({ tool, error }) {
  return h(Box, { paddingLeft: 2 },
    h(Text, { color: 'red' }, '✗ '),
    h(Text, { color: 'red' }, `${tool}  error: ${error}`)
  );
}

function ItemThinking({ text }) {
  return h(Box, { paddingLeft: 2 },
    h(Text, { color: 'gray', dimColor: true }, `[thinking] ${text.slice(0, 200)}`)
  );
}

function ItemError({ message }) {
  return h(Box, { paddingLeft: 2, marginY: 1 },
    h(Text, { color: 'red' }, `✗  ${message}`)
  );
}

function ItemInfo({ text }) {
  return h(Box, { paddingLeft: 2 },
    h(Text, { color: 'gray' }, `› ${text}`)
  );
}

function ItemHelp() {
  return h(Box, { flexDirection: 'column', marginY: 1, paddingLeft: 2 },
    h(Text, { color: 'cyan', bold: true }, 'Commands'),
    ...SLASH_COMMANDS.map(({ cmd, desc }) =>
      h(Box, { key: cmd },
        h(Text, { color: 'white' }, cmd.padEnd(14)),
        h(Text, { color: 'gray' }, desc)
      )
    ),
    h(Text, { color: 'gray' }, '!<command>    run a local shell command'),
    h(Text, { color: 'gray' }, 'images        drag-drop a photo or paste/type a path (PNG, JPG, WebP, GIF, BMP, HEIC)')
  );
}

function ItemStatus({ agentId, session, primaryProvider, providerOverride, modelOverride, showTools, showThinking }) {
  return h(Box, { flexDirection: 'column', marginY: 1, paddingLeft: 2 },
    h(Text, { color: 'cyan', bold: true }, 'Status'),
    h(Box, null, h(Text, { color: 'gray' }, 'agent         '), h(Text, { color: 'white' }, agentId)),
    h(Box, null, h(Text, { color: 'gray' }, 'session       '), h(Text, { color: 'white' }, session)),
    h(Box, null, h(Text, { color: 'gray' }, 'primary prov. '), h(Text, { color: 'white' }, primaryProvider)),
    h(Box, null,
      h(Text, { color: 'gray' }, 'prov. override'),
      h(Text, { color: providerOverride ? 'white' : 'gray' }, ` ${providerOverride || 'none'}`)
    ),
    h(Box, null,
      h(Text, { color: 'gray' }, 'model         '),
      h(Text, { color: modelOverride ? 'white' : 'gray' }, modelOverride || 'agent default')
    ),
    h(Box, null, h(Text, { color: 'gray' }, 'tools         '), h(Text, { color: showTools ? 'green' : 'red' }, showTools ? 'on' : 'off')),
    h(Box, null, h(Text, { color: 'gray' }, 'thinking      '), h(Text, { color: showThinking ? 'green' : 'red' }, showThinking ? 'on' : 'off'))
  );
}

function ItemContext({
  coreSystemTokens, agentFilesTokens, fileBreakdown,
  skillsTokens, skillsCount, runtimeTokens, toolsCount,
  perTurnTokens, conversationTokens, messageCount,
  model, provider, exact, source, lastUsage,
  limit, approx,
}) {
  const labelWidth = 16;
  const cacheDetail = lastUsage
    ? `${formatCacheTokens(lastUsage)}${formatCacheHitPct(lastUsage)}`.replace(/^ · /, '  ')
    : '';

  // The generation the model produced over the session — final answers plus the
  // reasoning and tool-call code that never persist into the message history —
  // is the conversation's real cost, so it is baked into the Conversation row.
  const generated = lastUsage?.outputTokens ?? 0;
  const conversationTotal = conversationTokens + generated;

  const segments = [
    { label: 'System prompt',  tokens: coreSystemTokens, color: 'cyan' },
    { label: 'Agent files',    tokens: agentFilesTokens, color: 'green',
      detail: (fileBreakdown ?? []).map((f) => `${f.file.padEnd(14)} ${formatTokens(f.tokens).padStart(6)}`) },
    { label: 'Skills catalog', tokens: skillsTokens,     color: 'magenta', suffix: ` (${skillsCount})` },
    { label: 'Tools & runtime', tokens: runtimeTokens,   color: 'yellow',  suffix: ` (${toolsCount} tools)` },
    { label: 'Memory & turn',  tokens: perTurnTokens,    color: 'blue' },
    { label: 'Conversation',   tokens: conversationTotal, color: 'white', suffix: ` (${messageCount} msg)`,
      detail: lastUsage
        ? [
            `↑ input    ${formatTokens(lastUsage.inputTokens).padStart(7)}${cacheDetail}`,
            `↓ output   ${formatTokens(generated).padStart(7)}  answers + reasoning + tool-call code`,
            `messages   ${formatTokens(conversationTokens).padStart(7)}  persisted history (sent next turn)`,
          ]
        : ['no measured usage yet'] },
  ];
  const total = segments.reduce((sum, s) => sum + s.tokens, 0) || 1;

  // ── Actual context-window utilization ──────────────────────────────────────
  // The measured occupancy of the most recent request is the ground truth. With
  // no request yet, fall back to the locally composed prompt size (segment sum).
  const windowLimit = limit || 200_000;
  const measuredUsed = promptOccupancy(lastUsage);
  const used = measuredUsed || total;
  const winPct = Math.min(100, Math.round((used / windowLimit) * 100));
  const free = Math.max(0, windowLimit - used);
  const winColor = winPct >= 85 ? 'red' : winPct >= 60 ? 'yellow' : 'green';
  const usedNote = measuredUsed
    ? 'measured occupancy of last request'
    : 'estimated from composed prompt (no request yet)';

  return h(Box, { flexDirection: 'column', marginY: 1, paddingLeft: 2 },
    h(Box, null,
      h(Text, { color: 'cyan', bold: true }, 'Context window'),
      h(Text, { color: 'gray' }, `   ${model}${provider ? ` · ${provider}` : ''}`)
    ),
    h(Box, { marginTop: 1 },
      h(Text, { color: winColor }, usageBar(winPct, 28)),
      h(Text, { color: 'white', bold: true }, `  ${formatTokens(used)} / ${approx ? '≈' : ''}${formatTokens(windowLimit)}`),
      h(Text, { color: 'gray' }, `  ${winPct}% used · ${formatTokens(free)} free`)
    ),
    h(Box, { marginBottom: 1 },
      h(Text, { color: 'gray', dimColor: true }, `  ${usedNote}`)
    ),
    h(Box, null,
      h(Text, { color: 'gray', bold: true }, 'Composition'),
      h(Text, { color: 'gray', dimColor: true }, '  (where the prompt tokens go)')
    ),
    ...segments.flatMap((seg) => {
      const pct = Math.round((seg.tokens / total) * 100);
      const rows = [
        h(Box, { key: seg.label },
          h(Text, { color: 'gray' }, (seg.label + (seg.suffix || '')).padEnd(labelWidth + 8).slice(0, labelWidth + 8)),
          h(Text, { color: seg.color }, usageBar(pct)),
          h(Text, { color: 'white' }, ` ${formatTokens(seg.tokens).padStart(6)}`),
          h(Text, { color: 'gray' }, ` ${String(pct).padStart(3)}%`)
        ),
      ];
      for (const [i, line] of (seg.detail ?? []).entries()) {
        rows.push(h(Box, { key: `${seg.label}-d${i}`, paddingLeft: 2 },
          h(Text, { color: 'gray', dimColor: true }, `· ${line}`)
        ));
      }
      return rows;
    }),
    h(Box, { marginTop: 1 },
      h(Text, { color: 'cyan', bold: true }, 'Composed prompt'.padEnd(labelWidth + 8)),
      h(Text, { color: 'white', bold: true }, ` ${formatTokens(total).padStart(28)} tokens`)
    ),
    h(Box, null,
      h(Text, { color: exact ? 'green' : 'yellow', dimColor: true }, exact ? `✓ composition counted via ${source}; window usage measured by provider` : `≈ ${source}`)
    )
  );
}

function ItemHistory({ messages }) {
  return h(Box, { flexDirection: 'column', marginY: 1, paddingLeft: 2 },
    h(Text, { color: 'cyan', bold: true }, `Session history (${messages.length} messages)`),
    ...messages.slice(-10).map((msg, i) => {
      const { text, images } = splitUserContent(msg.content);
      const summary = images.length
        ? `${text || '(image)'}  [${images.length} image${images.length === 1 ? '' : 's'}]`
        : text;
      return h(Box, { key: i },
        h(Text, { color: msg.role === 'user' ? 'cyan' : 'magenta' }, msg.role.padEnd(10)),
        h(Text, { color: 'gray' },
          summary.slice(0, 80) + (summary.length > 80 ? '…' : '')
        )
      );
    })
  );
}

function ItemShellOutput({ command, output, stderr, code }) {
  return h(Box, { flexDirection: 'column', paddingLeft: 2 },
    h(Box, null,
      h(Text, { color: 'gray' }, '$ '),
      h(Text, { color: 'white' }, command),
      code !== 0 ? h(Text, { color: 'red' }, `  (exit ${code})`) : null
    ),
    output?.trim() ? h(Box, { paddingLeft: 2 },
      h(Text, { color: 'gray', wrap: 'wrap' }, output.trimEnd())
    ) : null,
    stderr?.trim() ? h(Box, { paddingLeft: 2 },
      h(Text, { color: 'red', wrap: 'wrap' }, stderr.trimEnd())
    ) : null
  );
}

function TodoPanel({ todos }) {
  if (!todos || todos.length === 0) return null;
  const active = todos.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  const done = todos.filter((t) => t.status === 'completed').length;
  const visible = active.length > 0 ? todos : todos.slice(-5);
  const marker = (status) => {
    if (status === 'completed') return { glyph: '✔', color: 'green' };
    if (status === 'in_progress') return { glyph: '▶', color: 'yellow' };
    if (status === 'cancelled') return { glyph: '✕', color: 'gray' };
    return { glyph: '○', color: 'cyan' };
  };
  return h(Box, { flexDirection: 'column', marginY: 1, paddingX: 2, borderStyle: 'round', borderColor: 'cyan' },
    h(Box, null,
      h(Text, { color: 'cyan', bold: true }, '📋 tasks  '),
      h(Text, { color: 'gray' }, `${done}/${todos.length} done · ${active.length} active`)
    ),
    ...visible.map((item) => {
      const { glyph, color } = marker(item.status);
      const dim = item.status === 'completed' || item.status === 'cancelled';
      return h(Box, { key: item.id },
        h(Text, { color }, ` ${glyph} `),
        h(Text, { dimColor: dim, wrap: 'truncate-end' }, item.content)
      );
    })
  );
}

function ItemClearSep() {
  return h(Box, { flexDirection: 'column', marginTop: 2 },
    h(Text, null, '\n'.repeat(28)),
    h(Box, null,
      h(Text, { color: 'cyan', bold: true }, '⬡ Lannr'),
      h(Text, { color: 'gray' }, '  ──────────────────────────────── cleared')
    ),
    h(Box, null,
      h(Text, { color: 'gray', dimColor: true }, '─'.repeat(58))
    )
  );
}

function StaticItem({ item }) {
  switch (item.type) {
    case 'header':       return h(ItemHeader, { key: item.id });
    case 'user':         return h(ItemUser, { key: item.id, content: item.content });
    case 'assistant':    return h(ItemAssistant, { key: item.id, content: item.content });
    case 'tool-call':    return h(ItemToolCall, { key: item.id, tool: item.tool, input: item.input });
    case 'tool-result':  return h(ItemToolResult, { key: item.id, tool: item.tool, durationMs: item.durationMs });
    case 'tool-error':   return h(ItemToolError, { key: item.id, tool: item.tool, error: item.error });
    case 'thinking':     return h(ItemThinking, { key: item.id, text: item.text });
    case 'error-msg':    return h(ItemError, { key: item.id, message: item.message });
    case 'info':         return h(ItemInfo, { key: item.id, text: item.text });
    case 'help':         return h(ItemHelp, { key: item.id });
    case 'status':       return h(ItemStatus, { key: item.id, ...item });
    case 'context':      return h(ItemContext, { key: item.id, ...item });
    case 'history':      return h(ItemHistory, { key: item.id, messages: item.messages });
    case 'shell-output': return h(ItemShellOutput, { key: item.id, ...item });
    case 'clear-sep':    return h(ItemClearSep, { key: item.id });
    default:             return null;
  }
}

// ─── Thinking indicator (left-to-right wave in blue/green theme) ─────────────

function WaveText({ text, tick }) {
  const chars = [...text];
  const len = chars.length;
  // Wave sweeps left → right, pauses briefly off-screen, then restarts.
  const period = len + 6;
  const head = tick % period;
  return h(Text, null,
    ...chars.map((ch, i) => {
      const d = head - i;
      let color = 'cyan';
      let bold = false;
      let dim = true;
      if (d === 0)              { color = 'greenBright'; bold = true;  dim = false; }
      else if (d === 1 || d === -1) { color = 'cyanBright';  bold = true;  dim = false; }
      else if (d === 2 || d === -2) { color = 'cyan';        bold = false; dim = false; }
      return h(Text, { key: i, color, bold, dimColor: dim }, ch);
    })
  );
}

function CompactingIndicator({ mode, beforeTokens, afterTokens, done }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (done) return undefined;
    const id = setInterval(() => setTick(t => (t + 1) % 4), 200);
    return () => clearInterval(id);
  }, [done]);
  const dots = done ? '' : '.'.repeat(tick);
  const label = done
    ? (mode === 'model' ? 'compacted (summarized)' : 'compacted')
    : (mode === 'model' ? `summarizing history${dots}` : `compacting history${dots}`);
  const stats = afterTokens
    ? `  ${formatTokens(beforeTokens)} → ${formatTokens(afterTokens)} tok`
    : (beforeTokens ? `  ${formatTokens(beforeTokens)} tok` : '');
  return h(Box, { paddingLeft: 2 },
    h(Text, { color: done ? 'green' : 'yellow' }, done ? '✔ ' : '⟳ '),
    h(Text, { color: done ? 'green' : 'yellow', bold: true }, label),
    h(Text, { color: 'gray' }, stats)
  );
}

function ThinkingIndicator({ agentId, startedAt }) {
  const [tick, setTick] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const animId = setInterval(() => setTick(t => (t + 1) % 10000), 90);
    const elapsedId = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
    return () => { clearInterval(animId); clearInterval(elapsedId); };
  }, [startedAt]);
  const name = agentId || 'agent';
  const text = `${name} is thinking (${elapsed} seconds elapsed)`;
  return h(WaveText, { text, tick });
}

// ─── Main chat application ────────────────────────────────────────────────────

export function ChatApp(opts) {
  const { exit } = useApp();

  const agentState = useRef({
    agentId: opts.agent,
    agentName: opts.agent,
    provider: opts.provider,
    model: opts.model,
    session: opts.session,
    showTools: opts.tools !== false,
    showThinking: opts.thinking === true,
  });
  // Bumped whenever the active agent/model changes so the footer (which reads
  // from the agentState ref) re-renders to reflect it.
  const [, setFooterTick] = useState(0);
  const bumpFooter = useCallback(() => setFooterTick((n) => n + 1), []);
  const historyLimit = numberOr(opts.historyLimit, 200);
  const conversationHistory = useRef([]);

  const [staticItems, setStaticItems] = useState([{ type: 'header', id: 'header-0' }]);
  const [streamingText, setStreamingText] = useState('');
  const [streamingLabel, setStreamingLabel] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  // Held in the live region (not <Static>) until the next user action, so the
  // layout doesn't snap when streaming ends.
  const [completedAssistant, setCompletedAssistantState] = useState(null);
  const completedAssistantRef = useRef(null);
  const setCompletedAssistant = useCallback((value) => {
    completedAssistantRef.current = value;
    setCompletedAssistantState(value);
  }, []);
  const flushCompletedAssistant = useCallback(() => {
    const text = completedAssistantRef.current;
    if (!text) return;
    completedAssistantRef.current = null;
    setCompletedAssistantState(null);
    setStaticItems(prev => [...prev, { type: 'assistant', id: `asst-${Date.now()}`, content: text }]);
  }, []);
  const [inputValue, setInputValue] = useState('');
  const [, setInputImages] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionIdx, setSuggestionIdx] = useState(0);
  const [cursorBump, setCursorBump] = useState(0);
  const handleSubmitRef = useRef(null);
  const messageQueueRef = useRef([]);
  // Shell-style recall: every non-empty submission (messages, /commands, !shell)
  // is appended here so ↑/↓ in the input can step back through prior entries.
  const inputHistoryRef = useRef([]);
  const isStreamingRef = useRef(false);
  const inputImagesRef = useRef([]);
  const inputParseSeqRef = useRef(0);
  const [queueVersion, setQueueVersion] = useState(0);
  const [queuedCount, setQueuedCount] = useState(0);
  const [sessionTokens, setSessionTokens] = useState(null);
  // Live mirror of sessionTokens so callbacks with stale closures (handleSubmit
  // is memoized without sessionTokens in its deps) can read the current usage.
  const sessionTokensRef = useRef(null);
  // Most recent request's measured usage (replaced each turn, NOT summed) —
  // this is the true current context-window occupancy that /context reports.
  const [lastTurnUsage, setLastTurnUsage] = useState(null);
  const lastTurnUsageRef = useRef(null);
  const [streamingStartedAt, setStreamingStartedAt] = useState(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [todos, setTodos] = useState([]);
  const [clarifyQueue, setClarifyQueue] = useState([]);
  const [sessionsMenu, setSessionsMenu] = useState(null); // null | { items: [...] }
  const [agentsMenu, setAgentsMenu] = useState(null); // null | { items: [...] }
  const [modelsMenu, setModelsMenu] = useState(null); // null | { items: [...] }
  const [rateState, setRateState] = useState(null);
  const [compacting, setCompacting] = useState(null);
  const compactingClearRef = useRef(null);
  const userStopRef = useRef(false);
  const streamIterRef = useRef(null);
  useEffect(() => { sessionTokensRef.current = sessionTokens; }, [sessionTokens]);
  useEffect(() => { lastTurnUsageRef.current = lastTurnUsage; }, [lastTurnUsage]);
  const updateInputImages = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(inputImagesRef.current) : updater;
    inputImagesRef.current = next;
    setInputImages(next);
    return next;
  }, []);

  // ── Clarify-tool bridge ───────────────────────────────────────────────────
  // The `clarify` tool (src/agents/tools/clarify.js) suspends inside the agent
  // loop awaiting an answer. We subscribe to its bus, queue incoming requests,
  // and render the topmost as a ClarifyPrompt overlay. Submitting resolves the
  // tool handler so the agent can continue with the chosen answer.
  useEffect(() => {
    const detach = clarifyBus.attachUi();
    const handler = (req) => {
      const sessionId = agentState.current.session;
      // Only show prompts that match the active session (or aren't scoped).
      if (req.sessionId && sessionId && req.sessionId !== sessionId) return;
      setClarifyQueue((q) => [...q, req]);
    };
    clarifyBus.on('request', handler);
    return () => {
      clarifyBus.off('request', handler);
      detach();
    };
  }, []);

  useEffect(() => {
    let scheduler = null;
    let cancelled = false;

    async function startScheduler() {
      try {
        const config = await loadConfig();
        if (cancelled) return;
        scheduler = await startHubScheduler(config, {
          pollMs: 1000,
          log: () => {},
        });
      } catch (error) {
        if (cancelled) return;
        setStaticItems((prev) => [...prev, {
          type: 'error-msg',
          id: `sched-${Date.now()}`,
          message: `scheduler failed to start: ${error instanceof Error ? error.message : String(error)}`,
        }]);
      }
    }

    startScheduler();
    return () => {
      cancelled = true;
      scheduler?.stop?.().catch?.(() => {});
    };
  }, []);

  const activeClarify = clarifyQueue[0] ?? null;

  const onClarifyAnswer = useCallback((payload) => {
    if (!activeClarify) return;
    clarifyBus.answer(activeClarify.id, payload);
    setClarifyQueue((q) => q.slice(1));
    setStaticItems((prev) => [...prev, {
      type: 'info', id: `clr-${Date.now()}`,
      text: `clarify › ${payload.answer}`,
    }]);
  }, [activeClarify]);

  const onClarifyCancel = useCallback(() => {
    if (!activeClarify) return;
    clarifyBus.cancel(activeClarify.id);
    setClarifyQueue((q) => q.slice(1));
    setStaticItems((prev) => [...prev, {
      type: 'info', id: `clr-${Date.now()}`,
      text: 'clarify › dismissed',
    }]);
  }, [activeClarify]);

  const onSessionsMenuCancel = useCallback(() => {
    setSessionsMenu(null);
  }, []);

  const onSessionsMenuSelect = useCallback(async (picked) => {
    setSessionsMenu(null);
    const state = agentState.current;
    if (picked.id === state.session) {
      setStaticItems((prev) => [...prev, {
        type: 'info', id: `sw-${Date.now()}`,
        text: `already on session ${picked.id}`,
      }]);
      return;
    }
    try {
      // Persist the in-memory view of the current session before we swap it
      // out — /compact and other history mutations live only in memory until
      // the next turn, and we don't want to lose them on switch.
      await persistCurrentSession(state.agentId, state.session, conversationHistory.current, sessionTokens);
      const loaded = await loadChatSession(state.agentId, picked.id);
      agentState.current.agentId = loaded.agent.id;
      agentState.current.agentName = loaded.agent.name ?? loaded.agent.id;
      agentState.current.session = loaded.session.id;
      restoreSessionModel(agentState.current, loaded.session);
      bumpFooter();
      opts.onSessionChange?.(loaded.session.id, loaded.agent.id);
      conversationHistory.current = loaded.session.messages;
      trimHistory(conversationHistory.current, historyLimit);
      setSessionTokens(loaded.session.usage);
      setLastTurnUsage(loaded.session.lastUsage ?? null);
      setStaticItems([
        { type: 'header', id: `header-${Date.now()}` },
        ...itemsFromMessages(conversationHistory.current),
        { type: 'info', id: `sw-${Date.now()}`, text: `resumed session ${loaded.session.id}` },
      ]);
    } catch (error) {
      setStaticItems((prev) => [...prev, {
        type: 'error-msg', id: `sw-${Date.now()}`,
        message: `session switch failed: ${error instanceof Error ? error.message : String(error)}`,
      }]);
    }
  }, [historyLimit, sessionTokens]);

  const onAgentsMenuCancel = useCallback(() => {
    setAgentsMenu(null);
  }, []);

  const onAgentsMenuSelect = useCallback(async (picked) => {
    setAgentsMenu(null);
    const state = agentState.current;
    if (picked.id === state.agentId) {
      setStaticItems((prev) => [...prev, {
        type: 'info', id: `ag-${Date.now()}`,
        text: `already on agent ${picked.id}`,
      }]);
      return;
    }
    try {
      // Persist the current session before swapping agents, then resume the
      // picked agent's last session (or create a new one if none exists).
      await persistCurrentSession(state.agentId, state.session, conversationHistory.current, sessionTokens);
      const loaded = await loadChatSession(picked.id, undefined);
      agentState.current.agentId = loaded.agent.id;
      agentState.current.agentName = loaded.agent.name ?? loaded.agent.id;
      agentState.current.session = loaded.session.id;
      restoreSessionModel(agentState.current, loaded.session);
      bumpFooter();
      opts.onSessionChange?.(loaded.session.id, loaded.agent.id);
      conversationHistory.current = loaded.session.messages;
      trimHistory(conversationHistory.current, historyLimit);
      setSessionTokens(loaded.session.usage);
      setLastTurnUsage(loaded.session.lastUsage ?? null);
      try {
        const existing = await loadTodos(loaded.agent, loaded.session.id);
        setTodos(existing.length ? existing : []);
      } catch {
        setTodos([]);
      }
      const note = loaded.session.turns.length
        ? `switched to ${loaded.agent.id} · resumed session ${loaded.session.id}`
        : `switched to ${loaded.agent.id} · new session ${loaded.session.id}`;
      setStaticItems([
        { type: 'header', id: `header-${Date.now()}` },
        ...itemsFromMessages(conversationHistory.current),
        { type: 'info', id: `ag-${Date.now()}`, text: note },
      ]);
    } catch (error) {
      setStaticItems((prev) => [...prev, {
        type: 'error-msg', id: `ag-${Date.now()}`,
        message: `agent switch failed: ${error instanceof Error ? error.message : String(error)}`,
      }]);
    }
  }, [historyLimit, sessionTokens]);

  const onModelsMenuCancel = useCallback(() => {
    setModelsMenu(null);
  }, []);

  const onModelsMenuSelect = useCallback((picked) => {
    setModelsMenu(null);
    const state = agentState.current;
    if (picked.id === state.model && picked.provider === state.provider) {
      setStaticItems((prev) => [...prev, {
        type: 'info', id: `md-${Date.now()}`,
        text: `already on model ${picked.id}`,
      }]);
      return;
    }
    agentState.current.model = picked.id;
    agentState.current.provider = picked.provider;
    // Remember the choice on the session right away so reopening/resuming
    // comes back on this model even if no turn has been sent yet.
    persistSessionModel(state.agentId, state.session, picked.id, picked.provider).catch(() => {});
    bumpFooter();
    setStaticItems((prev) => [...prev, {
      type: 'info', id: `md-${Date.now()}`,
      text: `model: ${picked.id} (provider ${picked.provider})`,
    }]);
  }, [bumpFooter]);

  useEffect(() => {
    let cancelled = false;
    async function hydrateSession() {
      try {
        const loaded = await loadChatSession(agentState.current.agentId, agentState.current.session);
        if (cancelled) return;
        agentState.current.agentId = loaded.agent.id;
        agentState.current.agentName = loaded.agent.name ?? loaded.agent.id;
        agentState.current.session = loaded.session.id;
        restoreSessionModel(agentState.current, loaded.session);
        bumpFooter();
        opts.onSessionChange?.(loaded.session.id, loaded.agent.id);
        conversationHistory.current = loaded.session.messages;
        trimHistory(conversationHistory.current, historyLimit);
        setSessionTokens(loaded.session.usage);
        setLastTurnUsage(loaded.session.lastUsage ?? null);
        try {
          const existing = await loadTodos(loaded.agent, loaded.session.id);
          if (!cancelled && existing.length) setTodos(existing);
        } catch {
          // best effort — missing/empty file is fine
        }
        setStaticItems([
          { type: 'header', id: 'header-0' },
          ...itemsFromMessages(conversationHistory.current),
          ...(loaded.session.turns.length ? [{ type: 'info', id: `resume-${Date.now()}`, text: `resumed session ${loaded.session.id}` }] : []),
        ]);
      } catch (error) {
        if (!cancelled) {
          setStaticItems(prev => [...prev, { type: 'error-msg', id: `session-${Date.now()}`, message: error instanceof Error ? error.message : String(error) }]);
        }
      } finally {
        if (!cancelled) setSessionLoaded(true);
      }
    }
    hydrateSession();
    return () => { cancelled = true; };
  }, [historyLimit]);

  // ── Seed initial message from CLI args (runs once) ────────────────────────
  useEffect(() => {
    if (!sessionLoaded) return;
    const initial = opts.message?.trim();
    if (!initial) return;
    conversationHistory.current.push({ role: 'user', content: initial });
    trimHistory(conversationHistory.current, historyLimit);
    setStaticItems(prev => [...prev, { type: 'user', id: `user-${Date.now()}`, content: initial }]);
    messageQueueRef.current.push(initial);
    setQueuedCount(messageQueueRef.current.length);
    setQueueVersion(v => v + 1);
  }, [sessionLoaded]); // eslint-disable-line

  // ── Streaming effect: drains the message queue one turn at a time ─────────
  useEffect(() => {
    if (isStreamingRef.current) return;
    if (!sessionLoaded) return;
    if (messageQueueRef.current.length === 0) return;
    isStreamingRef.current = true;
    messageQueueRef.current.shift();
    setQueuedCount(messageQueueRef.current.length);
    let cancelled = false;
    const state = agentState.current;

    async function doStream() {
      userStopRef.current = false;
      setIsStreaming(true);
      setStreamingText('');
      setStreamingLabel(false);
      setStreamingStartedAt(Date.now());

      let fullText = '';
      let gotVisibleDelta = false;
      let producedVisibleOutput = false;
      try {
        const gateway = await createLannrGateway(state.provider ? { provider: state.provider } : {});
        const messages = [...conversationHistory.current];

        const iter = gateway.streamEvents({
          agent: state.agentId,
          provider: state.provider,
          model: state.model,
          session: state.session,
          messages,
        }, () => {});
        streamIterRef.current = iter;
        for await (const event of iter) {
          if (cancelled || userStopRef.current) break;
          if (event.runtime?.agentId) agentState.current.agentId = event.runtime.agentId;
          if (event.type === 'lannr:answer:delta') {
            fullText += event.text;
            gotVisibleDelta = true;
            producedVisibleOutput = true;
            setStreamingLabel(true);
            setStreamingText(fullText);
          }
          if (event.type === 'lannr:program') {
            fullText = '';
            gotVisibleDelta = false;
            setStreamingText('');
            setStreamingLabel(false);
          }
          if (event.type === 'lannr:thinking' && state.showThinking) {
            producedVisibleOutput = true;
            setStaticItems(prev => [...prev, { type: 'thinking', id: `th-${Date.now()}`, text: event.text }]);
          }
          if (event.type === 'lannr:tool:call' && state.showTools) {
            producedVisibleOutput = true;
            setStaticItems(prev => [...prev, { type: 'tool-call', id: `tc-${Date.now()}`, tool: event.tool, input: event.input }]);
          }
          if (event.type === 'lannr:tool:result') {
            if (event.tool === 'todo' && event.output && Array.isArray(event.output.todos)) {
              setTodos(event.output.todos);
            }
            if (state.showTools) {
              setStaticItems(prev => [...prev, { type: 'tool-result', id: `tr-${Date.now()}`, tool: event.tool, durationMs: event.durationMs }]);
            }
          }
          if (event.type === 'lannr:tool:error') {
            producedVisibleOutput = true;
            setStaticItems(prev => [...prev, { type: 'tool-error', id: `te-${Date.now()}`, tool: event.tool, error: event.error }]);
          }
          if (event.type === 'lannr:checkpoint') {
            agentState.current.lastCheckpoint = { turnId: event.turnId, fileCount: event.fileCount };
            agentState.current.lastAgentForCheckpoint = event.runtime?.agentId ?? agentState.current.agentId;
          }
          if (event.type === 'lannr:model:usage' && event.usage) {
            setSessionTokens(prev => ({
              inputTokens: (prev?.inputTokens ?? 0) + (event.usage.inputTokens ?? 0),
              outputTokens: (prev?.outputTokens ?? 0) + (event.usage.outputTokens ?? 0),
              cacheReadTokens: (prev?.cacheReadTokens ?? 0) + (event.usage.cacheReadTokens ?? 0),
              cacheWriteTokens: (prev?.cacheWriteTokens ?? 0) + (event.usage.cacheWriteTokens ?? 0),
            }));
            // Replace (don't sum): the latest request's prompt size is the
            // current window occupancy, which is what /context reports.
            setLastTurnUsage(event.usage);
          }
          if (event.type === 'lannr:rate:state' && event.state) {
            setRateState(event.state);
          }
          if (event.type === 'lannr:compaction:start') {
            if (compactingClearRef.current) {
              clearTimeout(compactingClearRef.current);
              compactingClearRef.current = null;
            }
            setCompacting({ mode: event.mode, beforeTokens: event.beforeTokens, afterTokens: null, done: false });
          }
          if (event.type === 'lannr:compaction') {
            setCompacting({ mode: event.mode, beforeTokens: event.beforeTokens, afterTokens: event.afterTokens, done: true });
            compactingClearRef.current = setTimeout(() => {
              setCompacting(null);
              compactingClearRef.current = null;
            }, 2000);
          }
          if (event.type === 'lannr:answer' && event.text && !gotVisibleDelta) {
            fullText = event.text;
            producedVisibleOutput = true;
            setStreamingLabel(true);
            setStreamingText(fullText);
          }
        }

        if (!cancelled && fullText && !userStopRef.current) {
          conversationHistory.current.push({ role: 'assistant', content: fullText });
          trimHistory(conversationHistory.current, historyLimit);
          if (messageQueueRef.current.length > 0) {
            // Next turn starts immediately — commit now to keep order correct.
            setStaticItems(prev => [...prev, { type: 'assistant', id: `asst-${Date.now()}`, content: fullText }]);
          } else {
            setCompletedAssistant(fullText);
          }
          setStreamingText('');
          setStreamingLabel(false);
        }
        if (!cancelled && !userStopRef.current && !producedVisibleOutput) {
          setStaticItems(prev => [...prev, {
            type: 'info', id: `noresp-${Date.now()}`,
            text: '(no response from agent — try resending, or check provider/credentials)',
          }]);
        }
      } catch (error) {
        if (!cancelled) {
          const msg = error instanceof Error ? error.message : String(error);
          setStaticItems(prev => [...prev, { type: 'error-msg', id: `err-${Date.now()}`, message: msg }]);
          setStreamingText('');
          setStreamingLabel(false);
        }
      } finally {
        streamIterRef.current = null;
        isStreamingRef.current = false;
        if (!cancelled) {
          setIsStreaming(false);
          // Re-fire the effect so a queued message (if any) gets drained.
          setQueueVersion(v => v + 1);
        }
      }
    }

    doStream();
    return () => { cancelled = true; };
  }, [queueVersion, historyLimit, sessionLoaded]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useInput((_input, key) => {
    // Clarify prompt / sessions menu own the keyboard while open — short-circuit
    // so esc dismisses the overlay instead of stopping the in-flight turn,
    // and so arrow/enter keys don't leak into the suggestion list.
    if (activeClarify) return;
    if (sessionsMenu) return;
    if (agentsMenu) return;
    if (modelsMenu) return;
    if (key.ctrl && _input === 'c') {
      opts.onInterrupt?.(agentState.current.session, agentState.current.agentId);
      exit();
      return;
    }
    if (key.escape) {
      if (suggestions.length > 0) { setSuggestions([]); return; }
      if (isStreaming) {
        userStopRef.current = true;
        messageQueueRef.current.length = 0;
        setQueuedCount(0);
        // Instant UI feedback — don't wait for the next generator yield.
        setIsStreaming(false);
        setStreamingText('');
        setStreamingLabel(false);
        if (compactingClearRef.current) {
          clearTimeout(compactingClearRef.current);
          compactingClearRef.current = null;
        }
        setCompacting(null);
        setStaticItems(prev => [...prev, {
          type: 'info', id: `stop-${Date.now()}`,
          text: '(turn stopped by user)',
        }]);
        // Best-effort: tell the iterator to close so the background loop exits.
        try { streamIterRef.current?.return?.(); } catch {}
      }
      return;
    }
    if (key.return && suggestions.length > 0) {
      const chosen = suggestions[suggestionIdx].cmd;
      setSuggestions([]);
      setInputValue('');
      handleSubmitRef.current?.(chosen);
      return;
    }
    if (key.tab && suggestions.length > 0) {
      setInputValue(suggestions[suggestionIdx].cmd + ' ');
      setSuggestions([]);
      setCursorBump(n => n + 1);
      return;
    }
    if (key.upArrow && suggestions.length > 0) {
      setSuggestionIdx(i => (i - 1 + suggestions.length) % suggestions.length);
    }
    if (key.downArrow && suggestions.length > 0) {
      setSuggestionIdx(i => (i + 1) % suggestions.length);
    }
  });

  // ── Input change ──────────────────────────────────────────────────────────
  const handleInputChange = useCallback(async (val) => {
    const seq = ++inputParseSeqRef.current;
    setInputValue(val);
    updateInputImages((prev) => prev.filter((attachment) => val.includes(attachment.label)));
    if (val.startsWith('/')) {
      const matches = SLASH_COMMANDS.filter(c => c.cmd.startsWith(val));
      setSuggestions(matches);
      setSuggestionIdx(0);
    } else {
      setSuggestions([]);
    }
    try {
      const { cleanedText, images } = await extractImagePaths(val);
      if (seq !== inputParseSeqRef.current || images.length === 0) return;
      const existing = inputImagesRef.current.filter((attachment) => val.includes(attachment.label));
      let nextId = nextImageLabelId(existing);
      const next = [
        ...existing,
        ...images.map((image) => {
          const id = nextId++;
          return { id, label: `[Image #${id}]`, image };
        }),
      ];
      updateInputImages(next);
      setInputValue(textWithImageLabels(cleanedText, next));
      setSuggestions([]);
    } catch {
      // Leave unresolved or unreadable paths as typed text. Submit will surface
      // a real attachment error if one occurs while building the payload.
    }
  }, [updateInputImages]);

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (val) => {
    const trimmed = val.trim();
    if (!trimmed) return;
    // Record for ↑/↓ recall (skip consecutive duplicates, like a shell).
    const hist = inputHistoryRef.current;
    if (hist[hist.length - 1] !== trimmed) hist.push(trimmed);
    const attachedImages = inputImagesRef.current.filter((attachment) => trimmed.includes(attachment.label));
    setInputValue('');
    updateInputImages([]);
    setSuggestions([]);

    flushCompletedAssistant();

    if (trimmed.startsWith('!')) {
      const cmd = trimmed.slice(1).trim();
      if (!cmd) return;
      const result = await runShell(cmd);
      setStaticItems(prev => [...prev, { type: 'shell-output', id: `sh-${Date.now()}`, command: cmd, ...(result as Record<string, any>) }]);
      return;
    }

    if (trimmed.startsWith('/')) {
      await handleSlashCommand(trimmed, agentState, conversationHistory, historyLimit, setStaticItems, setSessionTokens, exit, opts.onSessionChange, setCompacting, compactingClearRef, setSessionsMenu, setAgentsMenu, setModelsMenu, lastTurnUsageRef.current);
      return;
    }

    // Detect image attachments (drag-and-drop pastes the path, or the user
    // types a path explicitly). Anything that resolves to an existing image
    // file gets pulled out of the text and attached as a multipart user turn.
    let content = attachedImages.length > 0
      ? buildUserContent({ text: stripImageLabels(trimmed), images: attachedImages.map((attachment) => attachment.image) })
      : trimmed;
    let attachmentNote = null;
    try {
      if (attachedImages.length > 0) {
        attachmentNote = `attached ${attachedImages.length} image${attachedImages.length === 1 ? '' : 's'}`;
      } else {
        const { cleanedText, images } = await extractImagePaths(trimmed);
        if (images.length > 0) {
          content = buildUserContent({ text: cleanedText, images });
          attachmentNote = `attached ${images.length} image${images.length === 1 ? '' : 's'}`;
        }
      }
    } catch (error) {
      setStaticItems(prev => [...prev, {
        type: 'error-msg', id: `img-${Date.now()}`,
        message: `image attach failed: ${error instanceof Error ? error.message : String(error)}`,
      }]);
      return;
    }

    if (typeof content === 'string' && !content) return;

    conversationHistory.current.push({ role: 'user', content });
    trimHistory(conversationHistory.current, historyLimit);
    setStaticItems(prev => [...prev, { type: 'user', id: `user-${Date.now()}`, content }]);
    if (attachmentNote) {
      setStaticItems(prev => [...prev, { type: 'info', id: `att-${Date.now()}`, text: attachmentNote }]);
    }
    messageQueueRef.current.push(content);
    setQueuedCount(messageQueueRef.current.length);
    setQueueVersion(v => v + 1);
  }, [historyLimit, exit, flushCompletedAssistant, updateInputImages]); // eslint-disable-line

  handleSubmitRef.current = handleSubmit;

  const state = agentState.current;

  return h(Box, { flexDirection: 'column' },
    h(Static, { items: staticItems },
      item => h(StaticItem, { key: item.id, item })
    ),
    isStreaming ? h(Box, { flexDirection: 'column', marginBottom: 1 },
      h(Box, null,
        h(Text, { color: 'magenta', bold: true }, '◆'),
        h(Text, { color: 'gray' }, ' Lannr')
      ),
      compacting ? h(CompactingIndicator, { ...compacting }) : null,
      !streamingLabel && streamingStartedAt ? h(Box, { paddingLeft: 2 },
        h(ThinkingIndicator, { agentId: state.agentId, startedAt: streamingStartedAt })
      ) : null,
      streamingText ? h(Box, { paddingLeft: 2 },
        h(Markdown, null, streamingText)
      ) : null
    ) : compacting ? h(Box, { flexDirection: 'column', marginBottom: 1 },
      h(Box, null,
        h(Text, { color: 'magenta', bold: true }, '◆'),
        h(Text, { color: 'gray' }, ' Lannr')
      ),
      h(CompactingIndicator, { ...compacting })
    ) : completedAssistant ? h(Box, { flexDirection: 'column', marginBottom: 1 },
      h(Box, null,
        h(Text, { color: 'magenta', bold: true }, '◆'),
        h(Text, { color: 'gray' }, ' Lannr')
      ),
      h(Box, { paddingLeft: 2 },
        h(Markdown, null, completedAssistant)
      )
    ) : null,
    h(TodoPanel, { todos }),
    activeClarify ? h(ClarifyPrompt, {
      request: activeClarify,
      onAnswer: onClarifyAnswer,
      onCancel: onClarifyCancel,
    }) : null,
    sessionsMenu ? h(SessionsMenu, {
      sessions: sessionsMenu.items,
      currentSessionId: state.session,
      onSelect: onSessionsMenuSelect,
      onCancel: onSessionsMenuCancel,
    }) : null,
    agentsMenu ? h(AgentsMenu, {
      agents: agentsMenu.items,
      currentAgentId: state.agentId,
      onSelect: onAgentsMenuSelect,
      onCancel: onAgentsMenuCancel,
    }) : null,
    modelsMenu ? h(ModelsMenu, {
      models: modelsMenu.items,
      currentModelId: state.model,
      currentProviderId: state.provider,
      onSelect: onModelsMenuSelect,
      onCancel: onModelsMenuCancel,
    }) : null,
    h(InputBar, { value: inputValue, onChange: handleInputChange, onSubmit: handleSubmit, isStreaming, suggestions, suggestionIdx, queuedCount, cursorBump, historyRef: inputHistoryRef, paused: Boolean(activeClarify) || Boolean(sessionsMenu) || Boolean(agentsMenu) || Boolean(modelsMenu) }),
    h(Box, { paddingX: 2 },
      h(Text, { color: 'gray', dimColor: true },
        `agent:${state.agentName || state.agentId || 'default'} · session:${state.session}` +
        (state.provider ? ` · provider:${state.provider}` : '') +
        (state.model ? ` · model:${state.model}` : '') +
        (todos.length ? ` · 📋${todos.filter(t => t.status==='completed').length}/${todos.length}` : '') +
        (sessionTokens ? ` · ↑${formatTokens(sessionTokens.inputTokens)} ↓${formatTokens(sessionTokens.outputTokens)}${formatCacheTokens(sessionTokens)}${formatCacheHitPct(sessionTokens)}` : '') +
        (rateState ? ` · ${formatRateStateCompact(rateState) ?? ''}` : '') +
        '  [esc] stop turn  [/exit] quit'
      )
    )
  );
}

// ─── Slash command handler ────────────────────────────────────────────────────

async function handleSlashCommand(command, agentState, conversationHistory, historyLimit, setStaticItems, setSessionTokens, exit, onSessionChange, setCompacting, compactingClearRef, setSessionsMenu, setAgentsMenu, setModelsMenu, lastUsage) {
  const [name, ...args] = command.slice(1).trim().split(/\s+/);
  const rest = args.join(' ').trim();
  const state = agentState.current;

  const addInfo = text => setStaticItems(prev => [...prev, { type: 'info', id: `i-${Date.now()}`, text }]);

  switch (name.toLowerCase()) {
    case 'q': case 'quit': case 'exit': exit(); break;
    case 'help':
      setStaticItems(prev => [...prev, { type: 'help', id: `help-${Date.now()}` }]);
      break;
    case 'clear':
      setStaticItems(prev => [...prev, { type: 'clear-sep', id: `clear-${Date.now()}` }]);
      break;
    case 'status': {
      const config = await loadConfig();
      setStaticItems(prev => [...prev, {
        type: 'status', id: `st-${Date.now()}`,
        agentId: state.agentId || config.defaultAgentId,
        session: state.session,
        primaryProvider: config.primaryProviderId,
        providerOverride: state.provider,
        modelOverride: state.model,
        showTools: state.showTools,
        showThinking: state.showThinking,
      }]);
      break;
    }
    case 'context': {
      try {
        // Rebuild the runtime exactly as a turn would, so the breakdown reflects
        // what is actually sent: agent system prompt, per-turn context, the
        // lannr base prompt (tool stubs + execution rules), and the conversation.
        const runtime = await createAgentRuntime({
          agentId: state.agentId,
          overrides: {
            ...(state.provider ? { provider: state.provider } : {}),
            ...(state.model ? { model: state.model } : {}),
            ...(state.session ? { session: state.session } : {}),
          },
        });
        const workspace = runtime.workspace;
        const agent = runtime.agent;
        const provider = runtime.provider;
        const model = runtime.model;

        // ── Gather the text of each context segment ─────────────────────────
        // Agent default instruction files (AGENTS.md, SOUL.md, …) as embedded
        // in the system prompt (with the divider that wraps each one).
        const files = [];
        for (const file of instructionFiles) {
          try {
            const content = (await readFile(join(workspace, file), 'utf8')).trim();
            if (!content) continue;
            files.push({ file, text: `\n--- ${file} ---\n${content}` });
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        }
        const skillsPrompt = await buildSkillsPrompt(agent);
        const skills = await listSkills({ deniedSkills: agent?.deniedSkills ?? [] });
        const systemPrompt = runtime.systemPrompt || '';               // core + files + skills
        const lannrBase = runtime.lannr?.buildSystemPrompt?.() ?? '';   // tool stubs + exec rules
        const toolsCount = (runtime.lannr as any)?.tools?.size ?? 0;
        const perTurn = runtime.perTurnContext || '';
        const convo = conversationHistory.current;
        const messageCount = convo.length;

        // ── Real token counts from the provider's own tokenizer ────────────
        // countTokens routes to the native count endpoint (Anthropic/Google) or
        // the o200k_base tokenizer (OpenAI/codex/compatible) — exact for all.
        const count = async (text) => {
          if (!text) return { tokens: 0, exact: true, source: '' };
          const r = await countTokens(provider, model, [{ role: 'user', content: text }]);
          return r && Number.isFinite(r.tokens) ? r : { tokens: estimateStringTokens(text), exact: false, source: '~4 chars/token estimate' };
        };

        const [sysRes, skillsRes, runtimeRes, perTurnRes, convoRes, perFileRes] = await Promise.all([
          count(systemPrompt),
          count(skillsPrompt),
          count(lannrBase),
          count(perTurn),
          convo.length ? countTokens(provider, model, convo) : Promise.resolve({ tokens: 0, exact: true, source: '' }),
          Promise.all(files.map((f) => count(f.text))),
        ]);

        const fileTokens = perFileRes.map((r) => r.tokens);
        const filesT = fileTokens.reduce((sum, t) => sum + t, 0);
        const seg = {
          core: Math.max(0, sysRes.tokens - filesT - skillsRes.tokens),  // system prompt minus files & skills
          files: filesT,
          skills: skillsRes.tokens,
          runtime: runtimeRes.tokens,
          perTurn: perTurnRes.tokens,
          conversation: convoRes?.tokens ?? 0,
        };
        // `exact`/`source` describe how the counts were obtained (system prompt
        // is always present, so its result is the representative one).
        const exact = sysRes.exact;
        const source = sysRes.source || '~4 chars/token estimate';

        setStaticItems(prev => [...prev, {
          type: 'context', id: `ctx-${Date.now()}`,
          coreSystemTokens: seg.core,
          agentFilesTokens: seg.files,
          fileBreakdown: files.map((f, i) => ({ file: f.file, tokens: fileTokens[i] })),
          skillsTokens: seg.skills, skillsCount: skills.length,
          runtimeTokens: seg.runtime, toolsCount,
          perTurnTokens: seg.perTurn,
          conversationTokens: seg.conversation, messageCount,
          model, provider: provider?.id,
          exact, source,
          lastUsage,
          ...modelContextWindow(model),
        }]);
      } catch (error) {
        addInfo(`context failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      break;
    }
    case 'agent': {
      try {
        const config = await loadConfig();
        const items = Object.values(config.agents);
        setAgentsMenu?.({ items });
      } catch (error) {
        addInfo(`agents failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      break;
    }
    case 'model': {
      try {
        const config = await loadConfig();
        const items = buildModelItems(config);
        if (items.length === 0) { addInfo('no models configured'); break; }
        // If the user passed a model name, switch directly without the menu.
        if (rest) {
          const match = items.find((m) => m.id === rest || m.id.toLowerCase() === rest.toLowerCase());
          if (!match) { addInfo(`model not found: ${rest}`); break; }
          agentState.current.model = match.id;
          agentState.current.provider = match.provider;
          persistSessionModel(agentState.current.agentId, agentState.current.session, match.id, match.provider).catch(() => {});
          addInfo(`model: ${match.id} (provider ${match.provider})`);
          break;
        }
        setModelsMenu?.({ items });
      } catch (error) {
        addInfo(`models failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      break;
    }
    case 'provider':
      if (!rest) addInfo(`provider: ${state.provider || 'agent default'}`);
      else { agentState.current.provider = rest; addInfo(`provider override: ${rest}`); }
      break;
    case 'sessions': {
      try {
        const config = await loadConfig();
        const key = state.agentId ?? config.defaultAgentId;
        const agent = config.agents[key] ?? Object.values(config.agents).find((entry) => (
          entry.id === key || entry.name?.toLowerCase() === String(key).toLowerCase() || entry.aliases?.includes(key)
        ));
        if (!agent) { addInfo(`agent not found: ${key}`); break; }
        const items = await listSessions(agent);
        setSessionsMenu?.({ items });
      } catch (error) {
        addInfo(`sessions failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      break;
    }
    case 'new': {
      try {
        const loaded = await createNewChatSession(state.agentId);
        agentState.current.agentId = loaded.agent.id;
        agentState.current.session = loaded.session.id;
        onSessionChange?.(loaded.session.id, loaded.agent.id);
        conversationHistory.current = [];
        setSessionTokens(zeroUsage());
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
        setStaticItems(prev => [
          ...prev,
          { type: 'header', id: `header-${Date.now()}` },
          { type: 'info', id: `new-${Date.now()}`, text: `new session: ${loaded.session.id}` },
        ]);
      } catch (error) {
        addInfo(`new session failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      break;
    }
    case 'history': {
      const h = conversationHistory.current;
      if (h.length === 0) addInfo('No messages in this session.');
      else setStaticItems(prev => [...prev, { type: 'history', id: `hi-${Date.now()}`, messages: h }]);
      break;
    }
    case 'tools':
      agentState.current.showTools = rest === 'off' ? false : rest === 'on' ? true : !state.showTools;
      addInfo(`tool output: ${agentState.current.showTools ? 'on' : 'off'}`);
      break;
    case 'thinking':
      agentState.current.showThinking = rest === 'off' ? false : rest === 'on' ? true : !state.showThinking;
      addInfo(`thinking output: ${agentState.current.showThinking ? 'on' : 'off'}`);
      break;
    case 'compact': {
      const history = conversationHistory.current;
      if (history.length === 0) { addInfo('nothing to compact (history is empty)'); break; }
      let resultMessages = null;
      let beforeTok = null;
      let afterTok = null;
      let modeUsed = null;
      try {
        const gateway = await createLannrGateway(state.provider ? { provider: state.provider } : {});
        for await (const event of gateway.compact({
          agent: state.agentId,
          provider: state.provider,
          model: state.model,
          session: state.session,
          messages: history,
        })) {
          if (event.type === 'lannr:compaction:start') {
            if (compactingClearRef?.current) {
              clearTimeout(compactingClearRef.current);
              compactingClearRef.current = null;
            }
            beforeTok = event.beforeTokens;
            setCompacting?.({ mode: event.mode, beforeTokens: event.beforeTokens, afterTokens: null, done: false });
          }
          if (event.type === 'lannr:compaction') {
            afterTok = event.afterTokens;
            modeUsed = event.mode;
            setCompacting?.({ mode: event.mode, beforeTokens: event.beforeTokens, afterTokens: event.afterTokens, done: true });
            if (compactingClearRef) {
              compactingClearRef.current = setTimeout(() => {
                setCompacting?.(null);
                compactingClearRef.current = null;
              }, 2500);
            }
          }
          if (event.type === 'lannr:compaction:result') {
            resultMessages = event.messages;
            if (event.skipped === 'too-short') addInfo('nothing to compact (conversation is too short)');
          }
        }
        if (resultMessages && resultMessages !== history) {
          conversationHistory.current = resultMessages;
          trimHistory(conversationHistory.current, historyLimit);
          const detail = beforeTok != null && afterTok != null
            ? `${formatTokens(beforeTok)} → ${formatTokens(afterTok)} tokens`
            : 'history compacted';
          addInfo(`compacted (${modeUsed ?? 'model'}): ${detail}`);
        }
      } catch (error) {
        if (compactingClearRef?.current) { clearTimeout(compactingClearRef.current); compactingClearRef.current = null; }
        setCompacting?.(null);
        addInfo(`compact failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      break;
    }
    case 'undo': {
      const config = await loadConfig();
      const agentId = agentState.current.lastAgentForCheckpoint ?? agentState.current.agentId ?? config.defaultAgentId;
      const agent = config.agents[agentId] ?? Object.values(config.agents).find((entry) => entry.id === agentId);
      if (!agent) { addInfo(`Cannot undo: agent ${agentId} not found.`); break; }
      const manager = createCheckpointManager(agent);
      const turnId = rest || agentState.current.lastCheckpoint?.turnId || (await manager.list())[0]?.turnId;
      if (!turnId) { addInfo('No checkpoints available.'); break; }
      try {
        const result = await manager.restore(turnId);
        addInfo(`Restored ${result.restored} file(s) from ${turnId}${result.removed.length ? `; removed ${result.removed.length} new file(s).` : '.'}`);
      } catch (error) {
        addInfo(`Undo failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      break;
    }
    default:
      addInfo(`unknown command: /${name}  (type /help for commands)`);
  }
}

// Flatten every provider's models into a single pick list. Each provider keeps
// its own model set (provider.models), falling back to its defaultModel. The
// synthetic "default" provider alias shares an id with the primary, so we dedupe
// by provider id + model to avoid listing the same model twice.
function buildModelItems(config) {
  const items = [];
  const seen = new Set();
  for (const provider of Object.values(config.providers) as any[]) {
    const models = provider.models?.length ? provider.models : (provider.defaultModel ? [provider.defaultModel] : []);
    for (const model of models) {
      const key = `${provider.id}:${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ id: model, provider: provider.id, isDefault: model === provider.defaultModel });
    }
  }
  return items;
}

async function loadChatSession(agentId, sessionId) {
  const config = await loadConfig();
  const key = agentId ?? config.defaultAgentId;
  const agent = config.agents[key] ?? Object.values(config.agents).find((entry) => (
    entry.id === key || entry.name?.toLowerCase() === String(key).toLowerCase() || entry.aliases?.includes(key)
  ));
  if (!agent) throw new Error(`Agent not found: ${key}`);
  const id = sessionId ? normalizeSessionId(sessionId) : (await loadLastSessionId(agent)) ?? generateSessionId();
  const session = await loadSession(agent, id);
  await saveLastSessionId(agent, session.id);
  return { agent, session };
}

async function persistCurrentSession(agentId, sessionId, messages, usage) {
  if (!sessionId) return;
  const config = await loadConfig();
  const key = agentId ?? config.defaultAgentId;
  const agent = config.agents[key] ?? Object.values(config.agents).find((entry) => (
    entry.id === key || entry.name?.toLowerCase() === String(key).toLowerCase() || entry.aliases?.includes(key)
  ));
  if (!agent) return;
  const session = await loadSession(agent, sessionId);
  session.messages = Array.isArray(messages) ? messages : session.messages;
  if (usage) session.usage = usage;
  session.updatedAt = new Date().toISOString();
  await saveSession(agent, session);
  await saveLastSessionId(agent, session.id);
}

// Restore the model/provider a session last ran on so resuming/reopening it
// comes back on the model the user last used (overriding the agent default).
function restoreSessionModel(state, session) {
  if (session?.model) state.model = session.model;
  if (session?.provider) state.provider = session.provider;
}

// Best-effort write of the chosen model/provider onto the session record, so a
// /model switch is remembered even before the next turn is sent.
async function persistSessionModel(agentId, sessionId, model, provider) {
  if (!sessionId || !model) return;
  const config = await loadConfig();
  const key = agentId ?? config.defaultAgentId;
  const agent = config.agents[key] ?? Object.values(config.agents).find((entry) => (
    entry.id === key || entry.name?.toLowerCase() === String(key).toLowerCase() || entry.aliases?.includes(key)
  ));
  if (!agent) return;
  const session = await loadSession(agent, sessionId);
  session.model = model;
  if (provider) session.provider = provider;
  session.updatedAt = new Date().toISOString();
  await saveSession(agent, session);
}

async function createNewChatSession(agentId) {
  const config = await loadConfig();
  const key = agentId ?? config.defaultAgentId;
  const agent = config.agents[key] ?? Object.values(config.agents).find((entry) => (
    entry.id === key || entry.name?.toLowerCase() === String(key).toLowerCase() || entry.aliases?.includes(key)
  ));
  if (!agent) throw new Error(`Agent not found: ${key}`);
  const session = await loadSession(agent, generateSessionId());
  await saveSession(agent, session);
  await saveLastSessionId(agent, session.id);
  return { agent, session };
}

// ─── Shell helper ─────────────────────────────────────────────────────────────

function runShell(command) {
  return new Promise(resolve => {
    const outChunks = [];
    const errChunks = [];
    const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => outChunks.push(d));
    child.stderr.on('data', d => errChunks.push(d));
    child.on('close', code => resolve({
      output: Buffer.concat(outChunks).toString('utf8'),
      stderr: Buffer.concat(errChunks).toString('utf8'),
      code,
    }));
    child.on('error', err => resolve({ output: '', stderr: err.message, code: 1 }));
  });
}
