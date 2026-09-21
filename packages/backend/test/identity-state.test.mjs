import test from 'brittle'

import {
  IDENTITY_STATE_KEY,
  readStoredIdentityRecords,
  readStoredIdentityState,
} from '../src/identity-state.js'

function metaDbWith (value) {
  return {
    async get (key) {
      return key === IDENTITY_STATE_KEY ? { value } : null
    },
  }
}

test('stored identity state is rejected unless the active identity is present', async t => {
  const identityA = { publicKey: '41'.repeat(32), driveKey: '51'.repeat(32) }
  const ghostB = { publicKey: '42'.repeat(32), driveKey: '52'.repeat(32) }

  const valid = metaDbWith({
    version: 1,
    activeIdentity: identityA.publicKey,
    identities: [identityA],
  })
  t.is((await readStoredIdentityState(valid)).activeIdentity, identityA.publicKey)
  t.alike(await readStoredIdentityRecords(valid), [identityA])

  const dangling = metaDbWith({
    version: 1,
    activeIdentity: ghostB.publicKey,
    identities: [identityA],
  })
  t.is(
    await readStoredIdentityState(dangling),
    null,
    'an active identity absent from the list must never activate',
  )
  t.alike(await readStoredIdentityRecords(dangling), [])
})

test('stored identity state is rejected for an unknown version or an absent record', async t => {
  t.is(await readStoredIdentityState(metaDbWith({
    version: 2,
    activeIdentity: null,
    identities: [],
  })), null)
  t.is(await readStoredIdentityState(metaDbWith(undefined)), null)
  t.is(await readStoredIdentityState({}), null, 'a store with no get() yields no state')
})
