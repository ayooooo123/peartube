const installedTargets = new WeakSet()

function getErrorMessage(error) {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return ''
}

export function isExpectedBlobRequestCancellation(error) {
  if (!error || error.code !== 'REQUEST_CANCELLED') return false

  const message = getErrorMessage(error)
  if (!message) return true
  return /request (was )?cancelled/i.test(message)
}

function defaultRethrow(reason) {
  setTimeout(() => {
    throw reason
  }, 0)
}

export function installExpectedBlobRequestCancellationHandler({
  processLike = globalThis.process,
  onConsumed = () => {},
  rethrow = defaultRethrow,
} = {}) {
  if (!processLike || typeof processLike.on !== 'function') {
    return { installed: false, reason: 'process-unavailable' }
  }
  if (installedTargets.has(processLike)) {
    return { installed: false, reason: 'already-installed' }
  }

  processLike.on('unhandledRejection', (reason) => {
    if (isExpectedBlobRequestCancellation(reason)) {
      onConsumed(reason)
      return
    }
    rethrow(reason)
  })

  installedTargets.add(processLike)
  return { installed: true }
}
