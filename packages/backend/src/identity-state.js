export const IDENTITY_STATE_KEY = 'identity-state:v1'

export function normalizeStoredIdentityState(value) {
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.identities) ||
    value.identities.length > 256
  ) {
    return null
  }
  const activeIdentity = value.activeIdentity || null
  if (
    activeIdentity != null &&
    !value.identities.some(identity => identity?.publicKey === activeIdentity)
  ) {
    return null
  }
  return {
    version: 1,
    activeIdentity,
    identities: value.identities,
  }
}

export async function readStoredIdentityState(metaDb) {
  if (typeof metaDb?.get !== 'function') return null
  const state = await metaDb.get(IDENTITY_STATE_KEY)
  return normalizeStoredIdentityState(state?.value)
}

export async function readStoredIdentityRecords(metaDb) {
  return (await readStoredIdentityState(metaDb))?.identities || []
}
