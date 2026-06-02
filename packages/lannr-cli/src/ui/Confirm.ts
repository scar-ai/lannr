import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

const h = React.createElement;

export function Confirm({ message, initialValue = true, onConfirm }) {
  const [selected, setSelected] = useState(initialValue);

  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow) setSelected(s => !s);
    else if (input === 'y' || input === 'Y') onConfirm(true);
    else if (input === 'n' || input === 'N') onConfirm(false);
    else if (key.return) onConfirm(selected);
  });

  return h(Box, { paddingY: 1 },
    h(Text, { color: 'cyan', bold: true }, '› '),
    h(Text, null, `${message}  `),
    h(Text, { color: selected ? 'green' : 'gray', bold: selected }, 'Yes'),
    h(Text, { color: 'gray' }, ' / '),
    h(Text, { color: !selected ? 'red' : 'gray', bold: !selected }, 'No'),
    h(Text, { color: 'gray', dimColor: true }, '  (y/n or ←→ then ↵)')
  );
}
