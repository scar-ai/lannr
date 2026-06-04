// Lightweight flavor for `/fortune` — a nod to Hermes' fortune cookie.
const FORTUNES = [
  'you are one clean refactor away from clarity',
  'a tiny rename today prevents a huge bug tomorrow',
  'the edge case you are ignoring is already solved in your head',
  'minimal diff, maximal calm',
  'today favors bold deletions over new abstractions',
  'the right helper is already in your codebase',
  'you will ship before overthinking catches up',
  'tests are about to save your future self',
  'your instincts are correctly suspicious of that one branch',
  'the agent reads faster than you can scroll',
  'name it well and the bug reveals itself',
]

const LEGENDARY = [
  'legendary drop: one-line fix, first try',
  'legendary drop: every flaky test passes cleanly',
  'legendary drop: your diff teaches by itself',
]

export function randomFortune(): string {
  const n = Math.floor(Math.random() * 0x7fffffff)
  const rare = n % 20 === 0
  const bag = rare ? LEGENDARY : FORTUNES
  return `${rare ? '🌟' : '🔮'} ${bag[n % bag.length]}`
}
