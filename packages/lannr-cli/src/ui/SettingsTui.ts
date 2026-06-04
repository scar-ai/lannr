import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { SETTING_DEFS, loadSettings, saveSettings } from '../settings.js';
import { theme } from './theme.js';

const h = React.createElement;

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export function SettingsTui() {
  const { exit } = useApp();
  const [loaded, setLoaded] = useState(null);
  const [draft, setDraft] = useState(null);
  const [index, setIndex] = useState(0);
  const [savedMessage, setSavedMessage] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadSettings()
      .then((settings) => {
        if (cancelled) return;
        setLoaded(settings);
        const init = {};
        for (const def of SETTING_DEFS) init[def.key] = settings[def.key] ?? def.default;
        setDraft(init);
      })
      .catch((err) => { if (!cancelled) setError(err?.message ?? String(err)); });
    return () => { cancelled = true; };
  }, []);

  useInput((input, key) => {
    if (!draft || savedMessage) return;
    const def = SETTING_DEFS[index];

    if (editing) {
      if (key.escape) { setEditing(false); setEditBuffer(''); return; }
      if (key.return) {
        const parsed = parseInt(editBuffer, 10);
        if (Number.isInteger(parsed)) {
          const min = def.min ?? 1;
          const max = def.max ?? Number.MAX_SAFE_INTEGER;
          setDraft((d) => ({ ...d, [def.key]: clamp(parsed, min, max) }));
        }
        setEditing(false);
        setEditBuffer('');
        return;
      }
      if (key.backspace || key.delete) { setEditBuffer((b) => b.slice(0, -1)); return; }
      if (input && /^[0-9]$/.test(input)) setEditBuffer((b) => (b + input).slice(0, 6));
      return;
    }

    if (key.escape) { exit(); return; }
    if (key.upArrow) { setIndex((i) => (i - 1 + SETTING_DEFS.length) % SETTING_DEFS.length); return; }
    if (key.downArrow) { setIndex((i) => (i + 1) % SETTING_DEFS.length); return; }

    if (def?.type === 'number') {
      const step = def.step ?? 1;
      const min = def.min ?? 1;
      const max = def.max ?? Number.MAX_SAFE_INTEGER;
      if (key.leftArrow) {
        setDraft((d) => ({ ...d, [def.key]: clamp((d[def.key] ?? def.default) - step, min, max) }));
        return;
      }
      if (key.rightArrow) {
        setDraft((d) => ({ ...d, [def.key]: clamp((d[def.key] ?? def.default) + step, min, max) }));
        return;
      }
      if (input === ' ') {
        setEditing(true);
        setEditBuffer(String(draft[def.key] ?? def.default));
        return;
      }
    }

    if (def?.type === 'boolean' && input === ' ') {
      setDraft((d) => ({ ...d, [def.key]: !d[def.key] }));
      return;
    }

    if (key.return) {
      (async () => {
        try {
          const next = { ...(loaded ?? {}), ...draft };
          await saveSettings(next);
          setSavedMessage('saved');
          setTimeout(() => exit(), 500);
        } catch (err) {
          setError(err?.message ?? String(err));
        }
      })();
    }
  });

  const c = theme();
  if (error) {
    return h(Box, { flexDirection: 'column', paddingY: 1, paddingX: 2 },
      h(Text, { color: c.error }, `settings error: ${error}`)
    );
  }
  if (!draft) {
    return h(Box, { paddingX: 2, paddingY: 1 },
      h(Text, { color: c.dim, dimColor: true }, 'loading settings…')
    );
  }

  const activeDef = SETTING_DEFS[index];
  let hint;
  if (savedMessage) hint = savedMessage;
  else if (editing) hint = 'type digits  ↵ confirm  esc cancel';
  else if (activeDef?.type === 'number') hint = '↑↓ navigate  ←→ adjust  space to type  ↵ save  esc cancel';
  else hint = '↑↓ navigate  space toggle  ↵ save  esc cancel';

  return h(Box, { flexDirection: 'column', paddingY: 1, paddingX: 2 },
    h(Box, { marginBottom: 1 },
      h(Text, { color: c.accent, bold: true }, '⬡ Lannr settings')
    ),
    ...SETTING_DEFS.map((def, i) => {
      const active = i === index;
      const value = draft[def.key];
      return h(Box, { key: def.key, flexDirection: 'column', marginBottom: 1 },
        h(Box, null,
          h(Text, { color: active ? c.accent : c.muted }, active ? '❯ ' : '  '),
          renderControl(def, value, active, editing && active, editBuffer),
          h(Text, null, ' '),
          h(Text, { color: active ? c.text : c.muted, bold: active }, def.label)
        ),
        h(Box, { paddingLeft: 6 },
          h(Text, { color: c.dim, dimColor: true }, def.description)
        )
      );
    }),
    h(Box, { marginTop: 1 },
      h(Text, { color: savedMessage ? c.success : c.dim, dimColor: !savedMessage }, hint)
    )
  );
}

function renderControl(def, value, active, isEditing, editBuffer) {
  const c = theme();
  if (def.type === 'boolean') {
    const box = value ? '[x]' : '[ ]';
    return h(Text, { color: value ? c.success : c.muted }, box);
  }
  if (def.type === 'number') {
    if (isEditing) {
      return h(Text, { color: c.warn }, `‹ ${editBuffer || '0'}_ ›`);
    }
    const arrowColor = active ? c.accent : c.muted;
    const valueColor = active ? c.success : c.muted;
    return h(Text, null,
      h(Text, { color: arrowColor }, '‹ '),
      h(Text, { color: valueColor, bold: active }, String(value)),
      h(Text, { color: arrowColor }, ' ›')
    );
  }
  return h(Text, { color: c.muted }, String(value));
}
