function cloneCanonicalState (state) {
  return JSON.parse(JSON.stringify(state))
}

export function createMemoryPortableStateRepository (initialState = {}) {
  let state = initialState
  let restoredDigest = null

  return Object.freeze({
    async snapshotPortableState () {
      return state
    },

    async restorePortableStateTransaction ({ manifestDigest, state: incomingState, itemCount }) {
      if (restoredDigest === manifestDigest) {
        return { importedCount: 0, skippedCount: itemCount, idempotent: true }
      }

      const portableState = cloneCanonicalState(incomingState)
      const stagedState = {
        ...(state && typeof state === 'object' && !Array.isArray(state) ? state : {}),
        ...portableState
      }

      state = stagedState
      restoredDigest = manifestDigest
      return { importedCount: itemCount, skippedCount: 0, idempotent: false }
    }
  })
}
