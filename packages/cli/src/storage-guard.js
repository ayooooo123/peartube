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
    try {
      const st = statfsSync(storagePath)
      const bsize = Number(st?.bsize) || 0
      const bavail = Number(st?.bavail) || 0
      if (bsize <= 0 || bavail < 0) return null
      return bavail * bsize
    } catch (err) {
      log?.('[storage-guard] statfs failed', err?.message || String(err))
      return null
    }
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
    // Free-disk floor ONLY, for DELIBERATE content (archive uploads/imports —
    // the relay's actual purpose). These must not be blocked just because the
    // evictable discovery cache filled the logical budget; only a genuinely low
    // disk (ENOSPC risk) refuses them.
    hasMinFreeDisk() {
      return !snapshot().lowDisk
    },
    // Bytes a single deliberate ingest may still write before it would reach the
    // free-disk floor, so a per-download ceiling can be clamped to what the disk
    // actually has. null when free space is not measurable (no statfs, or no
    // floor configured), which leaves the caller on its configured ceiling.
    headroomBytes() {
      const snap = snapshot()
      if (snap.freeBytes === null) return null
      const room = snap.freeBytes - snap.minFreeBytes
      return room > 0 ? room : 0
    },
    snapshot,
    // Force the next snapshot to re-measure (e.g. right after an eviction).
    invalidate() {
      cached = null
      cachedAt = 0
    },
  }
}
