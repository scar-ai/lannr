import { createHash } from 'node:crypto'
import { createLannrGateway } from '../gateway.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function handleStreamUpgrade(req, socket, _head, context) {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }

  const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'))

  let buffered = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk])
    let frame
    while ((frame = readFrame(buffered))) {
      buffered = buffered.subarray(frame.bytes)
      void handleFrame(frame, socket, context)
    }
  })
}

async function handleFrame(frame, socket, context) {
  if (frame.opcode === 0x8) {
    socket.end(encodeFrame('', 0x8))
    return
  }
  if (frame.opcode !== 0x1) return

  try {
    const request = JSON.parse(frame.payload.toString('utf8'))
    const gateway = await createLannrGateway(context.config)
    for await (const event of gateway.stream(request)) {
      socket.write(encodeFrame(JSON.stringify(event)))
    }
    socket.write(encodeFrame('[DONE]'))
  } catch (error) {
    socket.write(encodeFrame(JSON.stringify({
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: 'server_error',
        code: null,
      },
    })))
  }
}

function readFrame(buffer) {
  if (buffer.length < 2) return null
  const first = buffer[0]
  const second = buffer[1]
  const opcode = first & 0x0f
  const masked = Boolean(second & 0x80)
  let length = second & 0x7f
  let offset = 2

  if (length === 126) {
    if (buffer.length < offset + 2) return null
    length = buffer.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null
    const high = buffer.readUInt32BE(offset)
    const low = buffer.readUInt32BE(offset + 4)
    length = high * 2 ** 32 + low
    offset += 8
  }

  const maskOffset = offset
  if (masked) offset += 4
  if (buffer.length < offset + length) return null

  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4)
    for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
  }

  return { opcode, payload, bytes: offset + length }
}

function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.from(data)
  const headerLength = payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10
  const frame = Buffer.alloc(headerLength + payload.length)
  frame[0] = 0x80 | opcode
  if (payload.length < 126) {
    frame[1] = payload.length
  } else if (payload.length < 65536) {
    frame[1] = 126
    frame.writeUInt16BE(payload.length, 2)
  } else {
    frame[1] = 127
    frame.writeUInt32BE(0, 2)
    frame.writeUInt32BE(payload.length, 6)
  }
  payload.copy(frame, headerLength)
  return frame
}
