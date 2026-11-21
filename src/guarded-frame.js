// A Protomux message encoding whose decode never throws: Protomux closes the whole connection on a decoder that
// throws, so every decoder a stranger can reach goes through this. A message over `maxBytes`, or one the inner
// encoding cannot read, decodes to null, and the caller drops it.
export function guardedFrame (encoding, maxBytes) {
  return {
    preencode: encoding.preencode,
    encode: encoding.encode,
    decode (state) {
      const end = state.end
      if (end - state.start > maxBytes) {
        state.start = state.end = end
        return null
      }
      try {
        return encoding.decode(state)
      } catch {
        state.start = state.end = end
        return null
      }
    }
  }
}
