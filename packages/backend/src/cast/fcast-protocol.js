/**
 * FCast wire protocol codec (https://fcast.org)
 *
 * FCast is an open casting protocol used by FUTO / Grayjay receivers.
 * Transport is a plain TCP connection (default port 46899). Every message is:
 *
 *   [ 4 bytes  little-endian uint32: length of the REST of the message ]
 *   [ 1 byte   opcode                                                  ]
 *   [ length-1 bytes UTF-8 JSON body (optional; some opcodes are bare) ]
 *
 * This module is dependency-free (global Buffer only) so it runs unchanged
 * under both Bare and Node, and the framing can be unit-tested directly.
 */

export const FCAST_PORT = 46899

// Protocol version we advertise. v2 receivers reply to Ping and include
// duration/speed in PlaybackUpdate; v1 receivers simply ignore the
// version/ping opcodes they don't know.
export const FCAST_PROTOCOL_VERSION = 2

export const Opcode = {
  NONE: 0,
  PLAY: 1,
  PAUSE: 2,
  RESUME: 3,
  STOP: 4,
  SEEK: 5,
  PLAYBACK_UPDATE: 6,
  VOLUME_UPDATE: 7,
  SET_VOLUME: 8,
  PLAYBACK_ERROR: 9,
  SET_SPEED: 10,
  VERSION: 11,
  PING: 12,
  PONG: 13
}

// Receiver playback state values carried in PlaybackUpdate.
export const PlaybackState = {
  IDLE: 0,
  PLAYING: 1,
  PAUSED: 2
}

// Matches the reference implementation's MAXIMUM_PACKET_LENGTH. Anything
// larger is a corrupt stream or a hostile peer.
export const MAX_MESSAGE_LENGTH = 32000

const HEADER_LENGTH = 4

/**
 * Encode one FCast message.
 *
 * @param {number} opcode
 * @param {Object} [body] - JSON-serializable body; omit for bare opcodes
 * @returns {Buffer}
 */
export function encodeMessage(opcode, body) {
  const json = body === undefined || body === null ? null : JSON.stringify(body)
  const jsonBuf = json ? Buffer.from(json, 'utf8') : null
  const bodyLength = jsonBuf ? jsonBuf.length : 0

  const message = Buffer.alloc(HEADER_LENGTH + 1 + bodyLength)
  message.writeUInt32LE(1 + bodyLength, 0)
  message[HEADER_LENGTH] = opcode
  if (jsonBuf) jsonBuf.copy(message, HEADER_LENGTH + 1)
  return message
}

/**
 * Incremental decoder for the FCast byte stream. Feed it socket chunks in
 * any fragmentation; it returns fully framed messages as they complete.
 *
 * @example
 * const decoder = new FCastDecoder()
 * socket.on('data', (chunk) => {
 *   for (const msg of decoder.push(chunk)) handle(msg.opcode, msg.body)
 * })
 */
export class FCastDecoder {
  constructor() {
    this._buffer = Buffer.alloc(0)
  }

  /**
   * @param {Buffer} chunk
   * @returns {{opcode: number, body: Object|null}[]} completed messages
   * @throws {Error} on an invalid frame length (treat as fatal for the connection)
   */
  push(chunk) {
    this._buffer = this._buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this._buffer, chunk])

    const messages = []

    while (this._buffer.length >= HEADER_LENGTH) {
      const length = this._buffer.readUInt32LE(0)

      if (length < 1 || length > MAX_MESSAGE_LENGTH) {
        throw new Error(`Invalid FCast message length: ${length}`)
      }

      if (this._buffer.length < HEADER_LENGTH + length) break

      const opcode = this._buffer[HEADER_LENGTH]
      const bodyBuf = this._buffer.slice(HEADER_LENGTH + 1, HEADER_LENGTH + length)
      this._buffer = this._buffer.slice(HEADER_LENGTH + length)

      let body = null
      if (bodyBuf.length > 0) {
        try {
          body = JSON.parse(bodyBuf.toString('utf8'))
        } catch {
          body = null // tolerate malformed bodies; opcode alone is still useful
        }
      }

      messages.push({ opcode, body })
    }

    return messages
  }
}

export default { FCAST_PORT, FCAST_PROTOCOL_VERSION, Opcode, PlaybackState, MAX_MESSAGE_LENGTH, encodeMessage, FCastDecoder }
