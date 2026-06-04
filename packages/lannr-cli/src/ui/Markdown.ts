import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

const h = React.createElement;

// Inline tokenizer: bold, italic, code, links, strike.
// Order matters: handle code spans first so their contents are not re-parsed.
function tokenizeInline(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    // Inline code: `...`
    const codeMatch = rest.match(/^`([^`\n]+)`/);
    if (codeMatch) {
      out.push({ type: 'code', value: codeMatch[1] });
      i += codeMatch[0].length;
      continue;
    }

    // Bold: **...** or __...__
    const boldMatch = rest.match(/^(\*\*|__)([^*_\n]+?)\1/);
    if (boldMatch) {
      out.push({ type: 'bold', children: tokenizeInline(boldMatch[2]) });
      i += boldMatch[0].length;
      continue;
    }

    // Italic: *...* or _..._
    const italicMatch = rest.match(/^(\*|_)([^*_\n]+?)\1/);
    if (italicMatch) {
      out.push({ type: 'italic', children: tokenizeInline(italicMatch[2]) });
      i += italicMatch[0].length;
      continue;
    }

    // Strikethrough: ~~...~~
    const strikeMatch = rest.match(/^~~([^~\n]+?)~~/);
    if (strikeMatch) {
      out.push({ type: 'strike', children: tokenizeInline(strikeMatch[1]) });
      i += strikeMatch[0].length;
      continue;
    }

    // Link: [text](url)
    const linkMatch = rest.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)/);
    if (linkMatch) {
      out.push({ type: 'link', label: linkMatch[1], href: linkMatch[2] });
      i += linkMatch[0].length;
      continue;
    }

    // Plain run: take chars until the next potential marker
    const nextMarker = rest.slice(1).search(/[`*_~\[]/);
    const take = nextMarker === -1 ? rest.length : nextMarker + 1;
    out.push({ type: 'text', value: rest.slice(0, take) });
    i += take;
  }
  return out;
}

function renderInline(tokens, keyPrefix = 'i') {
  const c = theme();
  return tokens.map((tok, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (tok.type) {
      case 'text':
        return h(Text, { key, color: c.text }, tok.value);
      case 'code':
        return h(Text, { key, color: c.tool, backgroundColor: 'black' }, tok.value);
      case 'bold':
        return h(Text, { key, bold: true }, renderInline(tok.children, key));
      case 'italic':
        return h(Text, { key, italic: true }, renderInline(tok.children, key));
      case 'strike':
        return h(Text, { key, strikethrough: true }, renderInline(tok.children, key));
      case 'link':
        return h(Text, { key, color: c.accent, underline: true }, tok.label,
          h(Text, { color: c.dim }, ` (${tok.href})`));
      default:
        return null;
    }
  });
}

// Block parser: splits source into headings, fenced code, blockquotes, lists, and paragraphs.
function parseBlocks(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      blocks.push({ type: 'code', lang, value: buf.join('\n') });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Blockquote (consecutive `> ` lines)
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: buf.join('\n') });
      continue;
    }

    // List (unordered or ordered)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        const indent = m[1].length;
        const ordered = /\d+\./.test(m[2]);
        items.push({ indent, ordered, marker: m[2], text: m[3] });
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    // Blank line — paragraph separator
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph: gather until blank or block-starting line
    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', text: buf.join('\n') });
  }

  return blocks;
}

function isBlockStart(line) {
  return /^```/.test(line)
    || /^#{1,6}\s+/.test(line)
    || /^>\s?/.test(line)
    || /^\s*([-*+]|\d+\.)\s+/.test(line);
}

function renderBlock(block, key) {
  const c = theme();
  switch (block.type) {
    case 'heading': {
      const color = block.level <= 1 ? c.accent : block.level === 2 ? c.assistant : c.accentDim;
      const prefix = '#'.repeat(block.level) + ' ';
      return h(Box, { key, marginTop: 1 },
        h(Text, { color, bold: true }, prefix, ...renderInline(tokenizeInline(block.text), `${key}-h`))
      );
    }
    case 'code': {
      return h(Box, { key, flexDirection: 'column', marginY: 1, paddingX: 1, borderStyle: 'round', borderColor: c.dim },
        block.lang ? h(Text, { color: c.muted, dimColor: true }, block.lang) : null,
        h(Text, { color: c.success }, block.value)
      );
    }
    case 'quote': {
      return h(Box, { key, paddingLeft: 1 },
        h(Text, { color: c.accentDim }, '▎ '),
        h(Text, { color: c.muted, italic: true, wrap: 'wrap' }, ...renderInline(tokenizeInline(block.text), `${key}-q`))
      );
    }
    case 'list': {
      return h(Box, { key, flexDirection: 'column' },
        ...block.items.map((item, idx) => {
          const bullet = item.ordered ? `${item.marker} ` : '• ';
          return h(Box, { key: `${key}-li-${idx}`, paddingLeft: Math.floor(item.indent / 2) },
            h(Text, { color: c.tool }, bullet),
            h(Text, null, ...renderInline(tokenizeInline(item.text), `${key}-li-${idx}-x`))
          );
        })
      );
    }
    case 'hr':
      return h(Box, { key, marginY: 0 }, h(Text, { color: c.dim }, '─'.repeat(40)));
    case 'paragraph':
    default:
      return h(Box, { key },
        h(Text, { wrap: 'wrap' }, ...renderInline(tokenizeInline(block.text), `${key}-p`))
      );
  }
}

export function Markdown({ children }) {
  const src = typeof children === 'string' ? children : String(children ?? '');
  if (!src.trim()) return null;
  const blocks = parseBlocks(src);
  return h(Box, { flexDirection: 'column' },
    ...blocks.map((b, idx) => renderBlock(b, `b-${idx}`))
  );
}
