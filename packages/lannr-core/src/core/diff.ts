export type ApplyResult = { ok: true; program: string } | { ok: false; error: string }

export function applyDiff(currentProgram: string, patch: string): ApplyResult {
  if (!patch.trim()) return { ok: false, error: 'Patch is empty' }
  if (!patch.includes('@@')) return { ok: true, program: patch }
  const lines = patch.split('\n')
  const source = currentProgram.split('\n')
  const output: string[] = []
  let sourceIndex = 0

  for (let i = 0; i < lines.length; i++) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[i])
    if (!header) continue
    const start = Number(header[1]) - 1
    while (sourceIndex < start) output.push(source[sourceIndex++])
    i++
    for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const line = lines[i]
      if (line.startsWith('--- ') || line.startsWith('+++ ')) continue
      if (line.startsWith(' ')) {
        const expected = line.slice(1)
        if (source[sourceIndex] !== expected) return { ok: false, error: 'Patch did not apply - context lines may not match' }
        output.push(source[sourceIndex++])
      } else if (line.startsWith('-')) {
        const expected = line.slice(1)
        if (source[sourceIndex] !== expected) return { ok: false, error: 'Patch did not apply - removed line did not match' }
        sourceIndex++
      } else if (line.startsWith('+')) {
        output.push(line.slice(1))
      } else if (line === '\\ No newline at end of file') {
        continue
      }
    }
    i--
  }

  while (sourceIndex < source.length) output.push(source[sourceIndex++])
  return { ok: true, program: output.join('\n') }
}

export function generateDiff(before: string, after: string): string {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  return [
    '--- a/routine',
    '+++ b/routine',
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join('\n')
}
