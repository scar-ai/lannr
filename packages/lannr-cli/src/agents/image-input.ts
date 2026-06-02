// Parse image attachments out of a user-typed line and build a canonical
// multipart content payload that the rest of the pipeline (sessions, gateway,
// model adapters) can carry through.
//
// Supports two delivery modes:
//   - drag-and-drop into the terminal: pastes a path, often with
//     backslash-escaped spaces (Apple Terminal) or single-quote wrapping
//     (iTerm2), sometimes as a file:// URL.
//   - explicit path typed alongside text: bare absolute or relative path
//     ending in a known image extension.

import { promises as fs } from 'node:fs'
import path from 'node:path'

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif',
])

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

// Treated as one "image" for char-budget accounting so trajectory compression
// doesn't elide a recent user image just because the raw base64 is huge.
const IMAGE_BUDGET_CHARS = 800

export function mimeForPath(filePath) {
  const ext = path.extname(filePath ?? '').toLowerCase()
  return MIME_BY_EXT[ext] ?? null
}

export function isImagePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false
  const ext = path.extname(filePath).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

// Walk the input character-by-character, splitting on whitespace while
// honouring "double" / 'single' quotes and backslash-escapes. Tracks the
// original span of each token so we can later remove image references and
// rebuild the cleaned text.
export function tokenizeWithSpans(input) {
  const tokens = []
  const n = input.length
  let i = 0
  while (i < n) {
    while (i < n && /\s/.test(input[i])) i++
    if (i >= n) break
    const start = i
    let buf = ''
    let quote = null
    while (i < n) {
      const ch = input[i]
      if (quote) {
        if (ch === quote) { quote = null; i++; continue }
        if (ch === '\\' && i + 1 < n) { buf += input[i + 1]; i += 2; continue }
        buf += ch; i++; continue
      }
      if (ch === '"' || ch === "'") { quote = ch; i++; continue }
      if (ch === '\\' && i + 1 < n) { buf += input[i + 1]; i += 2; continue }
      if (/\s/.test(ch)) break
      buf += ch; i++
    }
    tokens.push({ token: buf, start, end: i })
  }
  return tokens
}

function fileUrlToPath(token) {
  if (!token || !token.startsWith('file://')) return null
  try {
    const url = new URL(token)
    return decodeURIComponent(url.pathname)
  } catch { return null }
}

export async function extractImagePaths(input, { cwd = process.cwd() }: Record<string, any> = {}) {
  if (!input || typeof input !== 'string') return { cleanedText: input ?? '', images: [] }
  const tokens = tokenizeWithSpans(input)
  const images = []
  const removed = []
  for (const tok of tokens) {
    const candidate = fileUrlToPath(tok.token) ?? tok.token
    if (!isImagePath(candidate)) continue
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate)
    try {
      const stat = await fs.stat(abs)
      if (!stat.isFile()) continue
      const buf = await fs.readFile(abs)
      images.push({
        path: candidate,
        absolutePath: abs,
        filename: path.basename(abs),
        mediaType: mimeForPath(abs) ?? 'image/png',
        data: buf.toString('base64'),
        sizeBytes: stat.size,
      })
      removed.push({ start: tok.start, end: tok.end })
    } catch {
      // Looks like an image path but doesn't exist — leave it in the text so
      // the user can see the unresolved reference instead of silently dropping.
    }
  }
  if (removed.length === 0) return { cleanedText: input, images: [] }
  let cleaned = input
  for (const span of [...removed].sort((a, b) => b.start - a.start)) {
    cleaned = cleaned.slice(0, span.start) + cleaned.slice(span.end)
  }
  return { cleanedText: cleaned.replace(/[ \t]+/g, ' ').trim(), images }
}

// Build the canonical content payload. Returns a plain string when no images
// are present (so the unchanged hot path stays a string), otherwise an array
// of `{type:'text'|'image', ...}` parts.
export function buildUserContent({ text, images }) {
  const trimmed = (text ?? '').trim()
  if (!images || images.length === 0) return trimmed
  const parts = []
  if (trimmed) parts.push({ type: 'text', text: trimmed })
  for (const img of images) {
    parts.push({
      type: 'image',
      mediaType: img.mediaType,
      data: img.data,
      source: img.path ?? img.absolutePath ?? null,
      filename: img.filename ?? null,
    })
  }
  return parts
}

export function isPartsContent(content) {
  return Array.isArray(content) && content.some((p) => p && typeof p === 'object' && (p.type === 'image' || p.type === 'text'))
}

export function partsToPlainText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  return content.map((p) => {
    if (typeof p === 'string') return p
    if (!p) return ''
    if (p.type === 'text') return p.text ?? ''
    if (p.type === 'image') return `[image: ${p.filename ?? p.source ?? 'attachment'}]`
    return p.text ?? ''
  }).join(' ').trim()
}

export function contentCharLength(content) {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return String(content ?? '').length
  let total = 0
  for (const part of content) {
    if (typeof part === 'string') total += part.length
    else if (part?.type === 'text') total += String(part.text ?? '').length
    else if (part?.type === 'image') total += IMAGE_BUDGET_CHARS
  }
  return total
}
