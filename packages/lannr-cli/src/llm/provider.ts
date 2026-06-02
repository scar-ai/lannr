import { createLannrGateway } from '../gateway.js'

export function createProvider() {
  return {
    async complete(request) {
      const gateway = await createLannrGateway()
      return gateway.complete(request)
    },
    async *stream(request) {
      const gateway = await createLannrGateway()
      yield* gateway.stream(request)
    },
  }
}
