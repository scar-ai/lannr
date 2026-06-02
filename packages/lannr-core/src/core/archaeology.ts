import type { EmbeddingProvider, ExecutionError, MemoryLike, ProgramDiffLike, RoutineLike } from './types.js'

export interface ArchaeologyResult {
  error: ExecutionError
  match: ArchaeologyMatch | null
  hint: string
}

export interface ArchaeologyMatch {
  routineName: string
  routineId: string
  similarity: number
  divergentLines: DivergentLine[]
  failedAttempts: ProgramDiffLike[]
}

export interface DivergentLine {
  lineNumber: number
  failingLine: string
  successfulLine: string
  annotation: string
}

export async function runArchaeology(program: string, error: ExecutionError, store: MemoryLike, embedder?: EmbeddingProvider): Promise<ArchaeologyResult> {
  const matches = await findSimilarRoutines(program, store, embedder)
  const best = matches[0]
  const match = best
    ? {
        routineName: best.routine.name,
        routineId: best.routine.id,
        similarity: best.similarity,
        divergentLines: diffPrograms(program, best.routine.program),
        failedAttempts: (best.routine.changelog ?? []).filter((diff) => diff.outcome === 'failure' || diff.resultedIn === 'failure'),
      }
    : null
  const result = { error, match, hint: '' }
  result.hint = buildHint(result)
  return result
}

export async function findSimilarRoutines(program: string, store: MemoryLike, embedder?: EmbeddingProvider, topK = 3, minSimilarity = 0.35): Promise<Array<{ routine: RoutineLike; similarity: number }>> {
  const summaries = await store.list({ minTrust: 'provisional' })
  const routines = (await Promise.all(summaries.map((summary) => store.get(summary.id)))).filter((routine): routine is RoutineLike => Boolean(routine))
  const scored = await Promise.all(routines.map(async (routine) => ({ routine, similarity: await routineSimilarity(program, routine, embedder) })))
  return scored.filter((item) => item.similarity >= minSimilarity).sort((a, b) => b.similarity - a.similarity).slice(0, topK)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, ai, i) => sum + ai * (b[i] ?? 0), 0)
  const normA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0))
  const normB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0))
  return normA && normB ? dot / (normA * normB) : 0
}

export function diffPrograms(failing: string, successful: string): DivergentLine[] {
  const failingLines = failing.split('\n')
  const successfulLines = successful.split('\n')
  const max = Math.max(failingLines.length, successfulLines.length)
  const divergent: DivergentLine[] = []
  for (let i = 0; i < max; i++) {
    if ((failingLines[i] ?? '') !== (successfulLines[i] ?? '')) {
      const failingLine = failingLines[i] ?? ''
      const successfulLine = successfulLines[i] ?? ''
      divergent.push({ lineNumber: i + 1, failingLine, successfulLine, annotation: annotate(failingLine || successfulLine, failingLine ? 'added' : 'removed') })
    }
  }
  return divergent
}

export function annotate(line: string, change: 'added' | 'removed'): string {
  const heuristics: Array<{ pattern: RegExp; annotation: string }> = [
    { pattern: /\.id\b(?!\s*\))/, annotation: 'Accessing .id directly - may need String() or Number() coercion' },
    { pattern: /await\s+\$\w+\([^)]+\)\s*\.\w+/, annotation: 'Chaining property access directly on await - wrap the awaited call in parentheses' },
    { pattern: /(?<!await\s)\$\w+\(/, annotation: 'Possible missing await before a tool call - tool bindings are async' },
    { pattern: /\.map\(/, annotation: 'Check whether async map callbacks need Promise.all' },
    { pattern: /JSON\.parse\(/, annotation: 'Check whether the value is already parsed before JSON.parse' },
    { pattern: /\?\./, annotation: 'Optional chaining may be needed to avoid null or undefined access' },
  ]
  return heuristics.find((item) => item.pattern.test(line))?.annotation ?? (change === 'added' ? 'Present in failing program, absent in successful' : 'Present in successful program, absent in failing')
}

export function buildHint(result: Pick<ArchaeologyResult, 'error' | 'match'>): string {
  if (!result.match) return `No similar successful programs found in the Routine corpus. Error: ${result.error.message}`
  const lines = [`Failure Archaeology (${Math.round(result.match.similarity * 100)}% match with "${result.match.routineName}"):`, `Error: ${result.error.message}`]
  for (const line of result.match.divergentLines.slice(0, 5)) {
    if (line.failingLine) lines.push(`FAILING: ${line.failingLine.trim()}`)
    if (line.successfulLine) lines.push(`SUCCESSFUL: ${line.successfulLine.trim()}`)
    lines.push(`NOTE: ${line.annotation}`)
  }
  for (const attempt of result.match.failedAttempts.slice(0, 2)) lines.push(`Previously failed fix: ${attempt.reason} (${attempt.failureError ?? 'no error recorded'})`)
  return lines.join('\n')
}

async function routineSimilarity(program: string, routine: RoutineLike, embedder?: EmbeddingProvider): Promise<number> {
  if (embedder && routine.embedding) return cosineSimilarity(await embedder.embed(program), routine.embedding)
  const a = tokenSet(program)
  const b = tokenSet(routine.program)
  const overlap = [...a].filter((token) => b.has(token)).length
  return overlap / Math.max(1, Math.sqrt(a.size * b.size))
}

function tokenSet(input: string): Set<string> {
  return new Set(input.toLowerCase().match(/[a-z_$][\w$]*/g) ?? [])
}
