export function isRecoverableCorestoreSeedMismatch(err) {
  if (err === 3) return true

  const message = err instanceof Error ? err.message : String(err || '')
  const numericCode = typeof err?.code === 'number' ? err.code : null
  const numericErrno = typeof err?.errno === 'number' ? err.errno : null

  return message.includes('Another corestore is stored here') ||
    message === '3' ||
    message.includes('number:3') ||
    numericCode === 3 ||
    numericErrno === 3
}

export function shouldRetryCorestoreSeedFallback(err, { hasIdentityKeyFile = false } = {}) {
  return Boolean(hasIdentityKeyFile) && isRecoverableCorestoreSeedMismatch(err)
}

export function isCorestoreLockError(err) {
  const message = (err instanceof Error ? err.message : String(err || '')).toLowerCase()

  return message.includes('file descriptor could not be locked') ||
    message.includes('lock hold by current process') ||
    message.includes('no locks available') ||
    (message.includes('corestore') && message.includes('locked'))
}
