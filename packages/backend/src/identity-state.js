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
  const authoritative = normalizeStoredIdentityState(state?.value)
  if (authoritative) return authoritative

  const [storedIdentities, storedActiveIdentity] = await Promise.all([
    metaDb.get('identities'),
    metaDb.get('activeIdentity'),
  ])
  const identities = Array.isArray(storedIdentities?.value)
    ? storedIdentities.value
    : []
  const activeIdentity = storedActiveIdentity?.value || null
  return {
    version: 1,
    activeIdentity: identities.some(identity => identity?.publicKey === activeIdentity)
      ? activeIdentity
      : null,
    identities,
  }
}

export async function readStoredIdentityRecords(metaDb) {
  return (await readStoredIdentityState(metaDb))?.identities || []
}
