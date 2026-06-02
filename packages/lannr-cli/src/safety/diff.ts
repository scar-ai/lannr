import { applyDiff, generateDiff } from 'lannr-core'

const CONTEXT_LINES = 3

export function generateUnifiedDiff(before, after, label = 'file') {
  const a = String(before ?? '').split('\n')
  const b = String(after ?? '').split('\n')
  const ops = diffLines(a, b)
  const hunks = collectHunks(ops, a, b, CONTEXT_LINES)
  if (hunks.length === 0) return ''
  const lines = [`--- a/${label}`, `+++ b/${label}`]
  for (const hunk of hunks) {
    const oldCount = hunk.body.filter((row) => row.kind === ' ' || row.kind === '-').length
    const newCount = hunk.body.filter((row) => row.kind === ' ' || row.kind === '+').length
    lines.push(`@@ -${hunk.oldStart + 1},${oldCount} +${hunk.newStart + 1},${newCount} @@`)
    for (const row of hunk.body) lines.push(`${row.kind}${row.text}`)
  }
  return lines.join('\n')
}

export function applyUnifiedDiff(currentText, patch) {
  return applyDiff(String(currentText ?? ''), String(patch ?? ''))
}

export function fullRewriteDiff(before, after) {
  return generateDiff(before, after)
}

function diffLines(a, b) {
  const m = a.length
  const n = b.length
  const max = Math.max(1, Math.min(m, n))
  if (m === 0 && n === 0) return []
  if (m === 0) return b.map((text) => ({ kind: '+', text, oldIdx: -1, newIdx: -1 }))
  if (n === 0) return a.map((text) => ({ kind: '-', text, oldIdx: -1, newIdx: -1 }))

  if (m * n > 4_000_000) {
    return [
      ...a.map((text) => ({ kind: '-', text })),
      ...b.map((text) => ({ kind: '+', text })),
    ]
  }

  const lcs = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) lcs[i][j] = lcs[i + 1][j + 1] + 1
      else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const ops = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i], oldIdx: i, newIdx: j })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: '-', text: a[i], oldIdx: i, newIdx: -1 })
      i++
    } else {
      ops.push({ kind: '+', text: b[j], oldIdx: -1, newIdx: j })
      j++
    }
  }
  while (i < m) ops.push({ kind: '-', text: a[i], oldIdx: i++, newIdx: -1 })
  while (j < n) ops.push({ kind: '+', text: b[j], oldIdx: -1, newIdx: j++ })
  return ops
}

function collectHunks(ops, a, b, context) {
  if (ops.every((op) => op.kind === ' ')) return []
  const hunks = []
  let current = null
  let trailingContext = 0

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]
    if (op.kind === ' ') {
      if (current) {
        current.body.push(op)
        trailingContext++
        if (trailingContext > context * 2) {
          while (current.body.length && current.body[current.body.length - 1].kind === ' ' && trailingContext > context) {
            current.body.pop()
            trailingContext--
          }
          hunks.push(current)
          current = null
          trailingContext = 0
        }
      }
      continue
    }
    if (!current) {
      const startIdx = Math.max(0, k - context)
      const leading = ops.slice(startIdx, k).filter((row) => row.kind === ' ')
      const oldStart = leading.length ? leading[0].oldIdx : op.kind === '-' ? op.oldIdx : findNearestOldIdx(ops, k)
      const newStart = leading.length ? leading[0].newIdx : op.kind === '+' ? op.newIdx : findNearestNewIdx(ops, k)
      current = { oldStart: Math.max(0, oldStart ?? 0), newStart: Math.max(0, newStart ?? 0), body: [...leading, op] }
    } else {
      current.body.push(op)
    }
    trailingContext = 0
  }
  if (current) {
    while (current.body.length && current.body[current.body.length - 1].kind === ' ' && trailingContext > context) {
      current.body.pop()
      trailingContext--
    }
    hunks.push(current)
  }
  return hunks
}

function findNearestOldIdx(ops, k) {
  for (let i = k; i < ops.length; i++) if (ops[i].oldIdx >= 0) return ops[i].oldIdx
  for (let i = k - 1; i >= 0; i--) if (ops[i].oldIdx >= 0) return ops[i].oldIdx
  return 0
}

function findNearestNewIdx(ops, k) {
  for (let i = k; i < ops.length; i++) if (ops[i].newIdx >= 0) return ops[i].newIdx
  for (let i = k - 1; i >= 0; i--) if (ops[i].newIdx >= 0) return ops[i].newIdx
  return 0
}
