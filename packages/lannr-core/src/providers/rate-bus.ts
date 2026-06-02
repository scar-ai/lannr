// Side-channel between provider adapters (which see HTTP response headers)
// and the gateway (which streams events to the UI). Adapters publish the
// latest rate-limit state per providerId; gateway snapshots it after every
// turn and yields a `lannr:rate:state` event when it changed.

import { EventEmitter } from 'node:events'

interface RateBusEntry {
  providerId: string
  state: unknown
  version: number
}

class RateBus extends EventEmitter {
  latest: Map<string, RateBusEntry>
  version: number

  constructor() {
    super()
    this.latest = new Map() // providerId → { state, version }
    this.version = 0
  }

  publish(providerId: string, state: unknown) {
    if (!providerId || !state) return
    this.version++
    const entry = { state, version: this.version, providerId }
    this.latest.set(providerId, entry)
    this.emit('state', entry)
  }

  // Snapshot version number — gateway compares before vs after to detect
  // whether a turn actually produced fresh data.
  snapshot() {
    return this.version
  }

  get(providerId: string) {
    const entry = this.latest.get(providerId)
    return entry ? entry.state : null
  }
}

export const rateBus = new RateBus()
