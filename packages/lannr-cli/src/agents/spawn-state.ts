let spawnDepth = 0

export function getSpawnDepth() {
  return spawnDepth
}

export function incrementSpawnDepth() {
  spawnDepth += 1
}

export function decrementSpawnDepth() {
  spawnDepth = Math.max(0, spawnDepth - 1)
}
