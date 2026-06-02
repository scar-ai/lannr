// Fuzzy snippet matching for editFile / applyPatch when the exact-match path
// fails. Strategy: normalize trailing whitespace + indentation, then look for
// the normalized needle within the normalized haystack. Returns a slice of the
// original haystack (preserving original whitespace) along with a confidence
// score in [0, 1]. Modeled after hermes' fuzzy_match.py.

export function fuzzyFindUnique(haystack, needle, { whitespace = true, indent = true } = {}) {
  if (!haystack || !needle) return null

  const exactIdx = haystack.indexOf(needle)
  if (exactIdx >= 0) {
    if (haystack.indexOf(needle, exactIdx + needle.length) >= 0) return null
    return { start: exactIdx, end: exactIdx + needle.length, match: needle, score: 1 }
  }

  const candidates = []

  if (whitespace) {
    // 1. Line-by-line right-trim (most common: stale trailing spaces).
    const matches = findLineNormalized(haystack, needle, normalizeRightTrim)
    candidates.push(...matches.map((m) => ({ ...m, score: 0.95 })))
  }

  if (indent && candidates.length === 0) {
    // 2. Drop all leading whitespace on each line.
    const matches = findLineNormalized(haystack, needle, normalizeStripIndent)
    candidates.push(...matches.map((m) => ({ ...m, score: 0.8 })))
  }

  if (candidates.length === 0) {
    // 3. Aggressive: collapse all whitespace runs to a single space.
    const matches = findCollapsedWhitespace(haystack, needle)
    candidates.push(...matches.map((m) => ({ ...m, score: 0.65 })))
  }

  if (candidates.length === 0) return null
  if (candidates.length > 1) return null
  return candidates[0]
}

function normalizeRightTrim(line) { return line.replace(/[ \t]+$/g, '') }
function normalizeStripIndent(line) { return line.replace(/^[ \t]+/g, '').replace(/[ \t]+$/g, '') }

function findLineNormalized(haystack, needle, normalize) {
  const haystackLines = haystack.split('\n')
  const needleLines = needle.split('\n')
  const normHaystack = haystackLines.map(normalize)
  const normNeedle = needleLines.map(normalize)
  const matches = []
  outer:
  for (let i = 0; i + normNeedle.length <= normHaystack.length; i++) {
    for (let j = 0; j < normNeedle.length; j++) {
      if (normHaystack[i + j] !== normNeedle[j]) continue outer
    }
    const start = lineOffset(haystackLines, i)
    const end = lineOffset(haystackLines, i + normNeedle.length) - (i + normNeedle.length < haystackLines.length ? 1 : 0)
    matches.push({ start, end, match: haystack.slice(start, end) })
  }
  return matches
}

function findCollapsedWhitespace(haystack, needle) {
  const collapse = (s) => s.replace(/\s+/g, ' ').trim()
  const needleC = collapse(needle)
  if (!needleC) return []
  const matches = []
  // Walk by line so we can map back to a slice. Try expanding windows.
  const lines = haystack.split('\n')
  for (let i = 0; i < lines.length; i++) {
    let buf = ''
    for (let j = i; j < lines.length && j - i < 200; j++) {
      buf += (buf ? '\n' : '') + lines[j]
      if (collapse(buf) === needleC) {
        const start = lineOffset(lines, i)
        const end = start + buf.length
        matches.push({ start, end, match: buf })
        break
      }
      if (collapse(buf).length > needleC.length * 2) break
    }
  }
  return matches
}

function lineOffset(lines, index) {
  let offset = 0
  for (let i = 0; i < index && i < lines.length; i++) offset += lines[i].length + 1
  return offset
}
