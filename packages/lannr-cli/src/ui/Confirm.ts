import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from './theme.js';

const h = React.createElement;

export function Confirm({ message, initialValue = true, onConfirm }) {
  const c = theme();
  const [selected, setSelected] = useState(initialValue);

  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow) setSelected(s => !s);
    else if (input === 'y' || input === 'Y') onConfirm(true);
    else if (input === 'n' || input === 'N') onConfirm(false);
    else if (key.return) onConfirm(selected);
  });

  return h(Box, { paddingY: 1 },
    h(Text, { color: c.accent, bold: true }, '› '),
    h(Text, { color: c.text }, `${message}  `),
    h(Text, { color: selected ? c.success : c.muted, bold: selected }, 'Yes'),
    h(Text, { color: c.muted }, ' / '),
    h(Text, { color: !selected ? c.error : c.muted, bold: !selected }, 'No'),
    h(Text, { color: c.dim, dimColor: true }, '  (y/n or ←→ then ↵)')
  );
}
