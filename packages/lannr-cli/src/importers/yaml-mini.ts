// Minimal YAML subset parser for hermes config.yaml.
// Handles: maps, nested maps via indentation, string/bool/number scalars,
// flow scalars (single-line). Skips comments and empty lines.
// Strips quoting on string scalars. Not a full YAML parser.

type Node = Record<string, unknown>

export function parseYamlMini(text: string): Node {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const root: Node = {}
  const stack: { indent: number; node: Node }[] = [{ indent: -1, node: root }]

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const stripped = stripComment(raw)
    if (!stripped.trim()) continue
    const indent = raw.length - raw.trimStart().length
    const line = stripped.trim()
    if (line.startsWith('- ')) continue
    const colonIdx = findKeyColon(line)
    if (colonIdx < 0) continue

    const key = line.slice(0, colonIdx).trim()
    const valuePart = line.slice(colonIdx + 1).trim()

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }
    const parent = stack[stack.length - 1].node

    if (valuePart === '') {
      // Could be a nested map or empty
      const next: Node = {}
      parent[key] = next
      stack.push({ indent, node: next })
    } else {
      parent[key] = parseScalar(valuePart)
    }
  }

  return root
}

function stripComment(line: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble) {
      const prev = line[i - 1]
      if (prev === undefined || prev === ' ' || prev === '\t') return line.slice(0, i)
    }
  }
  return line
}

function findKeyColon(line: string): number {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === ':' && !inSingle && !inDouble) {
      const next = line[i + 1]
      if (next === undefined || next === ' ' || next === '\t') return i
    }
  }
  return -1
}

function parseScalar(value: string): unknown {
  if (value === '~' || value === 'null') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10)
  if (/^-?\d*\.\d+$/.test(value)) return Number.parseFloat(value)
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) out[key] = value
  }
  return out
}
