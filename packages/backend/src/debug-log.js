// Shared best-effort debug log. Writes to the file named by
// PEARTUBE_NATIVE_WORKLET_DEBUG_LOG when set; a no-op otherwise. Debug logging
// must never affect backend startup, so all failures are swallowed.

export function resolveDebugLogPath() {
  return globalThis?.process?.env?.PEARTUBE_NATIVE_WORKLET_DEBUG_LOG || null
}

export async function appendDebugLine(line) {
  const filePath = resolveDebugLogPath()
  if (!filePath) return

  try {
    const fsModule = await import('bare-fs')
    const fs = fsModule?.default ?? fsModule
    if (typeof fs?.appendFileSync !== 'function') return
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Best effort: never let debug logging break startup.
  }
}
