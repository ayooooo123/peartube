/**
 * An AbortController on runtimes that have one, and a faithful stand-in where
 * there is none. Bare has no global AbortController, so code that constructs one
 * directly works in Node and tests and then throws a ReferenceError on a phone -
 * which is exactly how playback preparation died the moment anyone pressed Play.
 */
export function createAbortController() {
  const AbortControllerCtor = globalThis?.AbortController
  if (typeof AbortControllerCtor === 'function') return new AbortControllerCtor()

  let aborted = false
  let reason
  const listeners = new Map()
  const signal = {
    onabort: null,
    get aborted() {
      return aborted
    },
    get reason() {
      return reason
    },
    throwIfAborted() {
      if (aborted) throw reason
    },
    addEventListener(type, listener, options = {}) {
      if (type !== 'abort' || (!listener?.handleEvent && typeof listener !== 'function')) return
      listeners.set(listener, options?.once === true)
    },
    removeEventListener(type, listener) {
      if (type === 'abort') listeners.delete(listener)
    },
  }

  return {
    signal,
    abort(nextReason) {
      if (aborted) return
      aborted = true
      reason = nextReason !== undefined ? nextReason : new Error('This operation was aborted')
      const event = { type: 'abort', target: signal, currentTarget: signal }
      const notify = (listener) => {
        try {
          if (typeof listener === 'function') listener.call(signal, event)
          else listener.handleEvent(event)
        } catch (error) {
          console.warn('[AbortController] abort listener failed:', error?.message || error)
        }
      }
      const onabort = signal.onabort
      const pendingListeners = Array.from(listeners.keys())
      listeners.clear()
      if (typeof onabort === 'function') notify(onabort)
      for (const listener of pendingListeners) notify(listener)
    },
  }
}
