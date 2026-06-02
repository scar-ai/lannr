// In-process bridge between the `clarify` tool (runs inside the agent loop)
// and the chat UI (renders the multiple-choice prompt). Both live in the same
// Node process during `lannr chat`, so a shared singleton is enough — no IPC.
//
// Flow:
//   1. tool handler calls `ask({ sessionId, question, options })` and awaits
//   2. bus stores a pending promise keyed by request id, emits 'request'
//   3. ChatApp listens, renders ClarifyPrompt, calls `answer(id, payload)`
//   4. pending promise resolves with the user's answer; tool returns it
//
// If no UI is attached (e.g. one-shot CLI mode), the tool falls back to the
// first option after a short grace period so the agent loop never deadlocks.

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

const NO_UI_TIMEOUT_MS = 250

class ClarifyBus extends EventEmitter {
  [key: string]: any

  constructor() {
    super()
    this.pending = new Map()
    this.uiAttached = 0
  }

  attachUi() {
    this.uiAttached++
    return () => {
      this.uiAttached = Math.max(0, this.uiAttached - 1)
    }
  }

  ask({ sessionId, question, options, reason }) {
    const id = randomUUID()
    const payload = { id, sessionId, question, options, reason }

    return new Promise((resolve) => {
      this.pending.set(id, resolve)

      // No UI listening — resolve with a "no-ui" sentinel so the model knows
      // its question wasn't shown and can proceed with a best guess.
      if (this.uiAttached === 0) {
        setTimeout(() => {
          if (!this.pending.has(id)) return
          this.pending.delete(id)
          resolve({
            answer: '(no interactive UI available — proceed with a sensible default and inform the user)',
            selectedIndex: null,
            freeText: null,
            noUi: true,
          })
        }, NO_UI_TIMEOUT_MS)
      }

      this.emit('request', payload)
    })
  }

  answer(id, { answer, selectedIndex, freeText }) {
    const resolve = this.pending.get(id)
    if (!resolve) return false
    this.pending.delete(id)
    resolve({
      answer: String(answer ?? ''),
      selectedIndex: typeof selectedIndex === 'number' ? selectedIndex : null,
      freeText: freeText ?? null,
      noUi: false,
    })
    this.emit('resolved', { id })
    return true
  }

  cancel(id) {
    const resolve = this.pending.get(id)
    if (!resolve) return false
    this.pending.delete(id)
    resolve({
      answer: '(user dismissed the clarification — proceed with a sensible default)',
      selectedIndex: null,
      freeText: null,
      noUi: false,
      cancelled: true,
    })
    this.emit('resolved', { id })
    return true
  }
}

export const clarifyBus = new ClarifyBus()
