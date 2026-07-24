function coreKeyOf(rendition = {}) {
  return rendition.core?.key || rendition.coreKey || null
}

function normalizeKey(value) {
  const next = String(value || '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(next) ? next : null
}

export function createAssetSession(options = {}) {
  const renditions = new Map()
  const active = new Map()
  const openCore = typeof options.openCore === 'function' ? options.openCore : async key => key
  for (const rendition of options.manifest?.body?.renditions || []) {
    if (!rendition?.renditionId) continue
    renditions.set(rendition.renditionId, rendition)
  }

  return {
    async authorizeCore({ renditionId, coreKey } = {}) {
      const rendition = renditions.get(renditionId)
      if (!rendition || rendition.blocked || rendition.superseded) return false
      const expected = normalizeKey(coreKeyOf(rendition))
      const requested = normalizeKey(coreKey)
      if (!expected || !requested || expected !== requested) return false
      if (!active.has(renditionId)) active.set(renditionId, await openCore(requested, { rendition }))
      return true
    },
    activeCoreCount() {
      return active.size
    },
    close() {
      for (const core of active.values()) {
        try { core?.close?.() } catch {}
      }
      active.clear()
    },
  }
}
