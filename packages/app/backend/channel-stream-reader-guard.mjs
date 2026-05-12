export function createReaderAbortError(reason = 'aborted') {
  return reason instanceof Error ? reason : new Error(`ChannelStreamReader aborted: ${reason}`)
}

export function createReaderTimeoutError(offset, length) {
  return new Error(`ChannelStreamReader timed out waiting for ${length} bytes at offset ${offset}`)
}

export function isReadWaitExhausted({ now, deadline, attempts, maxReadAttempts }) {
  return now > deadline || attempts >= maxReadAttempts
}

export function normalizeReadWaitOptions(options = {}) {
  return {
    readTimeoutMs: Number.isFinite(options.readTimeoutMs) ? options.readTimeoutMs : 30000,
    maxReadAttempts: Number.isFinite(options.maxReadAttempts) ? options.maxReadAttempts : 1000,
    readAttemptDelayMs: Number.isFinite(options.readAttemptDelayMs) ? options.readAttemptDelayMs : 1,
    signal: options.signal || null
  }
}
