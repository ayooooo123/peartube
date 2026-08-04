// Ingestion gate that enforces the relay's defined storage threshold.
//
// Backend retention is quota-bounded, while archive imports can still consume
// the operator volume before the next maintenance pass. This independent gate
// prevents new ingestion at the configured storage or free-space boundary.
//
// This guard measures two signals and refuses new ingestion when either trips:
//   1. actual storage-dir bytes >= storage.maxBytes  (the defined threshold;
//      deterministic, not fooled by macOS/APFS purgeable-space accounting)
//   2. free disk on the volume < storage.minFreeBytes (secondary ENOSPC floor)
//
// It never evicts; it only stops growth. Measurement is cached to stay cheap on
// hot paths. Missing fs primitives degrade the affected signal to "ok" (fail
// open) so a limited runtime never wedges the relay.

const DEFAULT_TTL_MS = 30_000

// The host volume's real numbers, straight off one statfs: bytes a
// non-privileged writer may still add, and the volume's full size.
//
// This is a different question from the operator's byte budget, and the two
// must never be substituted for each other: the budget says how much of this
// machine the operator lent to PearTube, while these say how much machine
// there is. The participation decision measures its free-disk floor against
// the volume, so handing it storage.maxBytes would have it guard a number that
// is not a disk.
//
// A runtime without statfs (Bare's `#fs` does not export statfsSync) returns
// null, and a statfs that reports usable free blocks but no total reports
// `totalBytes: null` rather than dragging the free reading down with it — the
// free-disk floor needs only the first number. Nothing is estimated or
// substituted: what cannot be measured is reported as null, and every gate
// that needs the reading keeps failing closed.
export function measureVolumeBytes({ storagePath, statfsSync = null, log = null } = {}) {
  if (typeof storagePath !== 'string' || storagePath.length === 0) return null
  if (typeof statfsSync !== 'function') return null
  try {
    const st = statfsSync(storagePath)
    const bsize = Number(st?.bsize) || 0
    const bavail = Number(st?.bavail) || 0
    const blocks = Number(st?.blocks) || 0
    if (bsize <= 0 || bavail < 0) return null
    return { freeBytes: bavail * bsize, totalBytes: blocks > 0 ? blocks * bsize : null }
  } catch (err) {
    log?.(`[storage-guard] statfs failed: ${err?.message || String(err)}`)
    return null
  }
}

export function createStorageGuard({
  storagePath,
  maxBytes = 0,
  minFreeBytes = 0,
  statfsSync = null,
  statSync = null,
  readdirSync = null,
  log = null,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
  maxEntries = 200_000,
} = {}) {
  const budget = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0
  const floor = Number.isFinite(minFreeBytes) && minFreeBytes > 0 ? Math.floor(minFreeBytes) : 0
  const hasPath = typeof storagePath === 'string' && storagePath.length > 0
  const canMeasureUsage = budget > 0 && hasPath && typeof statSync === 'function' && typeof readdirSync === 'function'
  const canMeasureFree = floor > 0 && hasPath && typeof statfsSync === 'function'

  let cached = null
  let cachedAt = 0

  // What this runtime can actually measure, stated once at construction.
  //
  // A missing fs primitive degrades silently: the affected signal reads null,
  // its boundary never trips, and nothing anywhere says so. That is not
  // hypothetical — `#fs` did not export `statfsSync` for Bare, so on every real
  // relay `canMeasureFree` was false, `lowDisk` was permanently false, and the
  // configured free-disk floor measured nothing for this project's entire life
  // while the Node tests passed. A gate you cannot see is a gate you cannot
  // trust, so it reports its own capability, and the free-space probe runs once
  // here so the number is on the record rather than inferred from a later
  // refusal that may never come.
  log?.(`[storage-guard] path=${hasPath ? storagePath : 'unset'}` +
    ` budget=${budget > 0 ? budget : 'off'} usage=${canMeasureUsage ? 'measurable' : 'unmeasurable'}` +
    ` floor=${floor > 0 ? floor : 'off'} free=${canMeasureFree ? 'measurable' : 'unmeasurable'}`)
  if (canMeasureFree) log?.(`[storage-guard] statfs ${storagePath}: freeBytes=${measureFreeBytes()}`)

  // Actual allocated bytes under the storage dir. Uses block allocation
  // (blocks * 512) so sparse Hypercore/RocksDB .blob files — and holes punched
  // by eviction — are measured like `du`, not by logical file length.
  function measureUsedBytes() {
    let total = 0
    let visited = 0
    const stack = [storagePath]
    while (stack.length > 0) {
      const dir = stack.pop()
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (++visited > maxEntries) return total
        const full = `${dir}/${entry.name}`
        if (entry.isDirectory()) {
          stack.push(full)
          continue
        }
        try {
          const st = statSync(full)
          total += Number.isFinite(st.blocks) && st.blocks >= 0
            ? st.blocks * 512
            : (Number(st.size) || 0)
        } catch {
          // File vanished mid-walk (compaction); ignore.
        }
      }
    }
    return total
  }

  function measureFreeBytes() {
    return measureVolumeBytes({ storagePath, statfsSync, log })?.freeBytes ?? null
  }

  function compute() {
    const usedBytes = canMeasureUsage ? measureUsedBytes() : null
    const freeBytes = canMeasureFree ? measureFreeBytes() : null
    const overBudget = budget > 0 && usedBytes !== null && usedBytes >= budget
    const lowDisk = floor > 0 && freeBytes !== null && freeBytes < floor
    return {
      ok: !overBudget && !lowDisk,
      enabled: canMeasureUsage || canMeasureFree,
      usedBytes,
      freeBytes,
      maxBytes: budget,
      minFreeBytes: floor,
      overBudget,
      lowDisk,
    }
  }

  function snapshot() {
    if (!canMeasureUsage && !canMeasureFree) {
      return { ok: true, enabled: false, usedBytes: null, freeBytes: null, maxBytes: budget, minFreeBytes: floor, overBudget: false, lowDisk: false }
    }
    const ts = now()
    if (cached && ts - cachedAt < ttlMs) return cached
    cached = compute()
    cachedAt = ts
    return cached
  }

  return {
    // Full gate (budget + free-disk floor) for DISCRETIONARY growth such as the
    // discovery cache mirror: stop filling once the logical budget is reached.
    canIngest() {
      return snapshot().ok
    },
    // Bytes one archive may still add before either the aggregate storage
    // budget or the free-disk floor is reached. A signal that cannot be
    // measured is omitted; null means neither bound is measurable.
    headroomBytes() {
      const snap = snapshot()
      const limits = []
      if (snap.usedBytes !== null && snap.maxBytes > 0) {
        limits.push(Math.max(0, snap.maxBytes - snap.usedBytes))
      }
      if (snap.freeBytes !== null && snap.minFreeBytes > 0) {
        limits.push(Math.max(0, snap.freeBytes - snap.minFreeBytes))
      }
      return limits.length > 0 ? Math.min(...limits) : null
    },
    snapshot,
    // Force the next snapshot to re-measure (e.g. right after an eviction).
    invalidate() {
      cached = null
      cachedAt = 0
    },
  }
}
