function defaultDescribeError(error) {
  if (!error) return 'unknown'
  if (typeof error === 'string') return error
  if (typeof error === 'number') return `number:${error}`
  return error?.message || String(error)
}

async function defaultAppendDebugLine() {}

export async function closeCorestoreStorageIgnoringErrors(
  store,
  label,
  {
    appendDebugLine = defaultAppendDebugLine,
    describeError = defaultDescribeError
  } = {}
) {
  const storage = store?.storage
  if (!storage?.close) return

  try {
    await storage.close()
    await appendDebugLine(`[storage] ${label} underlying storage close ok`)
  } catch (error) {
    await appendDebugLine(
      `[storage] ${label} underlying storage close failed ${describeError(error)}`
    )
  }
}

export async function cleanupFailedCorestoreOpen(
  store,
  label,
  {
    appendDebugLine = defaultAppendDebugLine,
    describeError = defaultDescribeError
  } = {}
) {
  try {
    await store?.close?.()
    await appendDebugLine(`[storage] ${label} store close ok`)
  } catch (error) {
    await appendDebugLine(
      `[storage] ${label} store close failed ${describeError(error)}`
    )
  }

  await closeCorestoreStorageIgnoringErrors(store, label, {
    appendDebugLine,
    describeError
  })
}
