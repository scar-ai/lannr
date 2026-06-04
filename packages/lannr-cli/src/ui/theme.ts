// Centralized color palette for the chat TUI. One mutable "active" theme that
// every component reads at render time, plus a handful of named palettes the
// user can switch between with `/theme`. Persisted to ~/.lannr/settings.json so
// the choice survives restarts.
//
// Colors are hex strings (ink renders them via truecolor) so palettes can be
// richer than the 16 ANSI names. Where a terminal lacks truecolor support ink
// degrades them to the nearest ANSI color automatically.

import { loadSettings, saveSettings } from '../settings.js'

export type Palette = {
  name: string
  label: string
  brand: string      // hexagon / wordmark
  accent: string     // prompt caret, headings, primary highlight
  accentDim: string  // secondary accent / borders
  user: string       // "You" label + gutter
  assistant: string  // "Lannr" marker + gutter
  tool: string       // tool-call rows
  toolOk: string     // tool-result ok
  thinking: string   // spinner / thinking wave head
  success: string
  warn: string
  error: string
  text: string       // primary body text
  muted: string      // secondary text
  dim: string        // tertiary / separators
}

const THEMES: Record<string, Palette> = {
  lannr: {
    name: 'lannr', label: 'Lannr (default)',
    brand: '#7DD3FC', accent: '#38BDF8', accentDim: '#0EA5E9',
    user: '#67E8F9', assistant: '#C084FC',
    tool: '#FBBF24', toolOk: '#4ADE80', thinking: '#22D3EE',
    success: '#4ADE80', warn: '#FBBF24', error: '#F87171',
    text: '#E5E7EB', muted: '#94A3B8', dim: '#475569',
  },
  mono: {
    name: 'mono', label: 'Monochrome',
    brand: '#FFFFFF', accent: '#E5E7EB', accentDim: '#9CA3AF',
    user: '#FFFFFF', assistant: '#D1D5DB',
    tool: '#D1D5DB', toolOk: '#FFFFFF', thinking: '#E5E7EB',
    success: '#FFFFFF', warn: '#D1D5DB', error: '#FFFFFF',
    text: '#E5E7EB', muted: '#9CA3AF', dim: '#4B5563',
  },
  dracula: {
    name: 'dracula', label: 'Dracula',
    brand: '#BD93F9', accent: '#FF79C6', accentDim: '#BD93F9',
    user: '#8BE9FD', assistant: '#FF79C6',
    tool: '#F1FA8C', toolOk: '#50FA7B', thinking: '#8BE9FD',
    success: '#50FA7B', warn: '#F1FA8C', error: '#FF5555',
    text: '#F8F8F2', muted: '#BFBFD6', dim: '#6272A4',
  },
  nord: {
    name: 'nord', label: 'Nord',
    brand: '#88C0D0', accent: '#81A1C1', accentDim: '#5E81AC',
    user: '#8FBCBB', assistant: '#B48EAD',
    tool: '#EBCB8B', toolOk: '#A3BE8C', thinking: '#88C0D0',
    success: '#A3BE8C', warn: '#EBCB8B', error: '#BF616A',
    text: '#ECEFF4', muted: '#9aa6bd', dim: '#4C566A',
  },
  matrix: {
    name: 'matrix', label: 'Matrix',
    brand: '#22C55E', accent: '#4ADE80', accentDim: '#16A34A',
    user: '#86EFAC', assistant: '#22C55E',
    tool: '#65A30D', toolOk: '#4ADE80', thinking: '#86EFAC',
    success: '#4ADE80', warn: '#A3E635', error: '#F87171',
    text: '#DCFCE7', muted: '#5fb37a', dim: '#166534',
  },
  sunset: {
    name: 'sunset', label: 'Sunset',
    brand: '#FB923C', accent: '#F97316', accentDim: '#EA580C',
    user: '#FDBA74', assistant: '#F472B6',
    tool: '#FACC15', toolOk: '#4ADE80', thinking: '#FB7185',
    success: '#4ADE80', warn: '#FACC15', error: '#EF4444',
    text: '#FFEDD5', muted: '#d6a98a', dim: '#7c5c43',
  },
}

let active: Palette = THEMES.lannr

export function theme(): Palette {
  return active
}

export function themeNames(): { name: string; label: string }[] {
  return Object.values(THEMES).map((t) => ({ name: t.name, label: t.label }))
}

export function setTheme(name: string): Palette | null {
  const next = THEMES[String(name || '').toLowerCase()]
  if (!next) return null
  active = next
  return next
}

// Load the persisted theme (best effort) and apply it. Returns the applied name.
export async function loadActiveTheme(): Promise<string> {
  try {
    const settings = await loadSettings()
    if (settings?.theme && THEMES[settings.theme]) active = THEMES[settings.theme]
  } catch {
    // missing/unreadable settings — keep the default
  }
  return active.name
}

export async function persistTheme(name: string): Promise<void> {
  try {
    const settings = await loadSettings()
    settings.theme = name
    await saveSettings(settings)
  } catch {
    // non-fatal: the in-memory switch still applied for this session
  }
}
