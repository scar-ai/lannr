import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from './theme.js';

const h = React.createElement;

export function MultiSelect({ items, onSelect, onCancel, label, initialValue }) {
  const c = theme();
  const initialIdx = Math.max(0, items.findIndex(item =>
    (typeof item === 'string' ? item : item.value) === initialValue
  ));
  const [index, setIndex] = useState(initialIdx);

  useInput((_input, key) => {
    if (key.upArrow) setIndex(i => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIndex(i => (i + 1) % items.length);
    else if (key.return) onSelect(items[index]);
    else if (key.escape && onCancel) onCancel();
  });

  return h(Box, { flexDirection: 'column', paddingY: 1 },
    label ? h(Box, { marginBottom: 1 },
      h(Text, { bold: true, color: c.accent }, label)
    ) : null,
    ...items.map((item, i) => {
      const isActive = i === index;
      const itemLabel = typeof item === 'string' ? item : (item.label ?? item.value);
      const hint = typeof item === 'object' ? item.hint : null;
      return h(Box, { key: i, paddingX: 1 },
        h(Text, { color: isActive ? c.accent : c.muted }, isActive ? '❯ ' : '  '),
        h(Text, { color: isActive ? c.text : c.muted, bold: isActive }, itemLabel),
        hint ? h(Text, { color: c.dim }, ` — ${hint}`) : null
      );
    }),
    h(Box, { marginTop: 1, paddingX: 1 },
      h(Text, { color: c.dim, dimColor: true },
        `↑↓ navigate  ↵ select${onCancel ? '  esc cancel' : ''}`
      )
    )
  );
}
