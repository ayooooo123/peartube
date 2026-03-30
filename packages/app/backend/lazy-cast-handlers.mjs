export const CAST_HANDLER_NAMES = [
  'castAvailable',
  'castStartDiscovery',
  'castStopDiscovery',
  'castGetDevices',
  'castAddManualDevice',
  'castConnect',
  'castDisconnect',
  'castPause',
  'castResume',
  'castStop',
  'castSeek',
  'castSetVolume',
  'castGetState',
  'castIsConnected',
  'castPlay',
]

export function attachLazyCastHandlers(backend, ensureAttached) {
  let ensurePromise = null

  async function ensureHandlers() {
    if (!ensurePromise) {
      ensurePromise = Promise.resolve()
        .then(() => ensureAttached())
        .catch((error) => {
          ensurePromise = null
          throw error
        })
    }

    return ensurePromise
  }

  for (const handlerName of CAST_HANDLER_NAMES) {
    const lazyHandler = async function (...args) {
      await ensureHandlers()

      const nextHandler = backend[handlerName]
      if (nextHandler === lazyHandler || typeof nextHandler !== 'function') {
        throw new Error(`Lazy cast handler did not attach ${handlerName}`)
      }

      return nextHandler.apply(this, args)
    }

    backend[handlerName] = lazyHandler
  }
}
