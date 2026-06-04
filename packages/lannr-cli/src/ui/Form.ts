import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { LineEditor } from './LineEditor.js';
import { theme } from './theme.js';

const h = React.createElement;

function initialValue(f) {
  if (f.type === 'boolean') return f.default ?? false;
  // Skills fields hold an allow-map (name -> boolean); everything is allowed by default.
  if (f.type === 'skills') return f.default ?? Object.fromEntries((f.skills ?? []).map(s => [s.name, true]));
  return f.default ?? '';
}

export function Form({ fields, onSubmit, onCancel, title }) {
  const c = theme();
  const [values, setValues] = useState(
    () => Object.fromEntries(fields.map(f => [f.name, initialValue(f)]))
  );
  const [currentIdx, setCurrentIdx] = useState(0);
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  // Skill sub-picker state (open + cursor) for the active `skills` field.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerIdx, setPickerIdx] = useState(0);

  useInput((input, key) => {
    const field = fields[currentIdx];

    // Skills sub-picker captures all input while open.
    if (pickerOpen && field?.type === 'skills') {
      const list = field.skills ?? [];
      if (key.escape) { setPickerOpen(false); return; }
      if (key.upArrow) { setPickerIdx(i => (i - 1 + list.length) % list.length); return; }
      if (key.downArrow) { setPickerIdx(i => (i + 1) % list.length); return; }
      if (input === ' ') {
        const nm = list[pickerIdx]?.name;
        if (nm) setValues(prev => ({ ...prev, [field.name]: { ...prev[field.name], [nm]: !prev[field.name]?.[nm] } }));
        return;
      }
      if (input === 'a') {
        const allOn = list.every(s => values[field.name]?.[s.name]);
        setValues(prev => ({ ...prev, [field.name]: Object.fromEntries(list.map(s => [s.name, !allOn])) }));
        return;
      }
      if (key.return) { setPickerOpen(false); handleSubmitField(field.name); return; }
      return;
    }

    if (key.escape && onCancel) { onCancel(); return; }
    if (submitted || !field) return;

    // Boolean fields are not driven by the LineEditor, so handle their keys here.
    if (field.type === 'boolean') {
      if (input === ' ') { setValues(prev => ({ ...prev, [field.name]: !prev[field.name] })); return; }
      if (key.return) handleSubmitField(field.name);
      return;
    }

    // Skills fields open the picker on enter.
    if (field.type === 'skills') {
      if (key.return) { setPickerIdx(0); setPickerOpen(true); return; }
      return;
    }
  });

  function handleSubmitField(name) {
    const field = fields[currentIdx];
    if (field.required && field.type !== 'boolean' && field.type !== 'skills' && !values[name]?.trim()) {
      setErrors(prev => ({ ...prev, [name]: 'This field is required' }));
      return;
    }
    setErrors(prev => { const next = { ...prev }; delete next[name]; return next; });
    if (currentIdx < fields.length - 1) {
      setCurrentIdx(i => i + 1);
    } else if (!submitted) {
      setSubmitted(true);
      onSubmit(values);
    }
  }

  // Skill picker overlay replaces the form while choosing.
  const activeField = fields[currentIdx];
  if (pickerOpen && activeField?.type === 'skills') {
    const list = activeField.skills ?? [];
    const allowed = values[activeField.name] ?? {};
    return h(Box, { flexDirection: 'column', paddingY: 1 },
      h(Box, { marginBottom: 1 },
        h(Text, { bold: true, color: c.accent }, '⬡ Global skills')
      ),
      list.length === 0
        ? h(Text, { color: c.dim, dimColor: true }, 'No global skills installed.')
        : h(Box, { flexDirection: 'column' },
          ...list.map((s, i) => {
            const active = i === pickerIdx;
            const on = allowed[s.name];
            return h(Box, { key: s.name },
              h(Text, { color: active ? c.accent : c.muted }, active ? '❯ ' : '  '),
              h(Text, { color: on ? c.success : c.muted }, on ? '[x] ' : '[ ] '),
              h(Text, { color: active ? c.text : c.muted, bold: active }, s.name),
              s.description ? h(Text, { color: c.dim, dimColor: true }, `  ${s.description}`) : null
            );
          })
        ),
      h(Box, { marginTop: 1 },
        h(Text, { color: c.dim, dimColor: true }, '↑↓ navigate  space allow/deny  a toggle all  ↵ done  esc back')
      )
    );
  }

  return h(Box, { flexDirection: 'column', paddingY: 1 },
    title ? h(Box, { marginBottom: 1 },
      h(Text, { bold: true, color: c.accent }, `◆ ${title}`)
    ) : null,
    ...fields.map((field, i) => {
      const isActive = i === currentIdx && !submitted;
      const isDone = i < currentIdx || submitted;
      const hasError = Boolean(errors[field.name]);
      const statusChar = isDone ? '✓' : isActive ? '›' : '○';
      const statusColor = isDone ? c.success : isActive ? c.accent : c.muted;
      const isBoolean = field.type === 'boolean';
      const isSkills = field.type === 'skills';
      const skillsCount = isSkills
        ? (() => { const all = field.skills ?? []; const on = all.filter(s => values[field.name]?.[s.name]).length; return `${on}/${all.length} allowed`; })()
        : '';

      return h(Box, { key: field.name, flexDirection: 'column', marginBottom: isActive ? 1 : 0 },
        h(Box, null,
          h(Text, { color: statusColor }, `${statusChar} `),
          h(Text, { color: isActive ? c.text : c.muted, bold: isActive }, field.label),
          field.required && !isDone ? h(Text, { color: c.error }, ' *') : null,
          isDone && isBoolean ? h(Text, { color: c.muted },
            `  ${values[field.name] ? '[x] on' : '[ ] off'}`
          ) : null,
          isDone && isSkills ? h(Text, { color: c.muted }, `  ${skillsCount}`) : null,
          isDone && !isBoolean && !isSkills && values[field.name] ? h(Text, { color: c.muted },
            `  ${field.secret ? '•'.repeat(Math.min(values[field.name].length, 12)) : values[field.name]}`
          ) : null
        ),
        isActive && isBoolean ? h(Box, { marginLeft: 2 },
          h(Text, { color: values[field.name] ? c.success : c.muted },
            values[field.name] ? '[x] enabled' : '[ ] disabled')
        ) : null,
        isActive && isSkills ? h(Box, { marginLeft: 2 },
          h(Text, { color: c.accent }, `[ ${skillsCount} ]`),
          h(Text, { color: c.dim, dimColor: true }, '  ↵ choose')
        ) : null,
        isActive && !isBoolean && !isSkills ? h(Box, { marginLeft: 2, marginTop: 0, borderStyle: 'round', borderColor: hasError ? c.error : c.accent, paddingX: 1 },
          h(LineEditor, {
            value: values[field.name],
            onChange: v => setValues(prev => ({ ...prev, [field.name]: v })),
            onSubmit: () => handleSubmitField(field.name),
            placeholder: field.placeholder ?? '',
            mask: field.secret ? '*' : undefined,
          })
        ) : null,
        isActive && hasError ? h(Box, { marginLeft: 2 },
          h(Text, { color: c.error }, errors[field.name])
        ) : null,
        isActive && field.hint && !hasError ? h(Box, { marginLeft: 2 },
          h(Text, { color: c.dim, dimColor: true }, field.hint)
        ) : null
      );
    }),
    h(Box, { marginTop: 1, paddingX: 1 },
      h(Text, { color: c.dim, dimColor: true },
        `${!submitted && fields[currentIdx]?.type === 'boolean' ? 'space toggle  ↵ confirm'
          : !submitted && fields[currentIdx]?.type === 'skills' ? '↵ choose skills'
          : '↵ confirm field'}${onCancel ? '  esc cancel' : ''}`
      )
    )
  );
}

export function InlinePrompt({ label, defaultValue = '', secret = false, onSubmit }) {
  const c = theme();
  const [value, setValue] = useState(defaultValue);
  return h(Box, { flexDirection: 'column', paddingY: 1 },
    h(Box, { marginBottom: 0 },
      h(Text, { color: c.accent, bold: true }, '› '),
      h(Text, { color: c.text }, label),
      defaultValue ? h(Text, { color: c.muted }, ` (${defaultValue})`) : null
    ),
    h(Box, { borderStyle: 'round', borderColor: c.accent, paddingX: 1, marginLeft: 2 },
      h(LineEditor, {
        value,
        onChange: setValue,
        onSubmit: () => onSubmit(value || defaultValue),
        placeholder: defaultValue || '',
        mask: secret ? '*' : undefined,
      })
    )
  );
}
