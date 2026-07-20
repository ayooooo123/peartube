const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug']

// Temporarily routes legacy console.* output from backend code on the single
// command's execution path to the injected stderr logger, then restores the
// originals. It never captures the explicit stdout result writer.
export function createDiagnosticScope ({ logger, target = console } = {}) {
  if (!logger || typeof logger.log !== 'function') {
    throw new Error('diagnostic scope requires a logger with a log method')
  }
  const originals = new Map()
  let installed = false

  return {
    install () {
      if (installed) return
      installed = true
      for (const method of CONSOLE_METHODS) {
        originals.set(method, target[method])
        target[method] = (...args) => {
          const emit = logger[method] || logger.log
          emit.call(logger, ...args)
        }
      }
    },
    restore () {
      if (!installed) return
      for (const method of CONSOLE_METHODS) {
        target[method] = originals.get(method)
      }
      originals.clear()
      installed = false
    }
  }
}

export async function withDiagnosticScope (logger, fn, { target = console } = {}) {
  const scope = createDiagnosticScope({ logger, target })
  scope.install()
  try {
    return await fn()
  } finally {
    scope.restore()
  }
}
