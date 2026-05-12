/**
 * @typedef {Record<string, unknown>} JsonFrame
 * @typedef {{ push(chunk: unknown): JsonFrame[], reset(): void }} JsonFrameParser
 */

/** @param {unknown} chunk */
function toText(chunk) {
  if (typeof chunk === 'string') return chunk
  if (chunk && typeof chunk === 'object' && typeof chunk.toString === 'function') return chunk.toString()
  return String(chunk ?? '')
}

/** @param {unknown} value */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** @param {string} text */
function tryParseObject(text) {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed[0] !== '{') return null

  try {
    const parsed = JSON.parse(trimmed)
    return isPlainObject(parsed) ? parsed : null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      message.includes('Unexpected end of JSON input') ||
      message.includes('unterminated') ||
      message.includes('end of data')
    ) {
      return undefined
    }
    return null
  }
}

/** @returns {JsonFrameParser} */
export function createJsonFrameParser() {
  let pending = ''

  return {
    /** @param {unknown} chunk */
    push(chunk) {
      const incoming = toText(chunk)
      if (!incoming) return []

      pending += incoming
      /** @type {JsonFrame[]} */
      const frames = []

      while (pending.length > 0) {
        const start = pending.indexOf('{')
        if (start === -1) {
          pending = ''
          break
        }

        if (start > 0) pending = pending.slice(start)

        let depth = 0
        let inString = false
        let escaped = false
        let frameEnd = -1

        for (let index = 0; index < pending.length; index += 1) {
          const char = pending[index]

          if (inString) {
            if (escaped) {
              escaped = false
            } else if (char === '\\') {
              escaped = true
            } else if (char === '"') {
              inString = false
            }
            continue
          }

          if (char === '"') {
            inString = true
          } else if (char === '{') {
            depth += 1
          } else if (char === '}') {
            depth -= 1
            if (depth === 0) {
              frameEnd = index + 1
              break
            }
            if (depth < 0) break
          }
        }

        if (frameEnd === -1) break

        const candidate = pending.slice(0, frameEnd)
        pending = pending.slice(frameEnd)
        const frame = tryParseObject(candidate)
        if (frame) frames.push(frame)
      }

      return frames
    },
    reset() {
      pending = ''
    },
  }
}

/** @param {JsonFrame} value */
export function encodeJsonFrame(value) {
  return JSON.stringify(value)
}
