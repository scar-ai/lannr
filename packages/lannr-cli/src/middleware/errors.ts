export class HttpError extends Error {
  [key: string]: any

  constructor(status, message, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

export function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function notFound(res) {
  sendJson(res, 404, {
    error: {
      message: 'Route not found',
      type: 'not_found_error',
      code: 'route_not_found',
    },
  })
}

export function handleError(error, res) {
  const status = error instanceof HttpError ? error.status : 500
  sendJson(res, status, {
    error: {
      message: error instanceof Error ? error.message : String(error),
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code: error instanceof HttpError ? error.details?.code ?? null : null,
    },
  })
}
