import test from 'brittle'

import {
  IDENTITY_STATE_KEY,
  readStoredIdentityRecords,
  readStoredIdentityState,
} from '../src/identity-state.js'

test('authoritative identity state wins over a stale legacy mirror', async t => {
  const identityA = { publicKey: '41'.repeat(32), driveKey: '51'.repeat(32) }
  const ghostB = { publicKey: '42'.repeat(32), driveKey: '52'.repeat(32) }
  const values = new Map([
    [IDENTITY_STATE_KEY, {
      version: 1,
      activeIdentity: identityA.publicKey,
      identities: [identityA],
    }],
    ['identities', [identityA, ghostB]],
    ['activeIdentity', ghostB.publicKey],
  ])
  const metaDb = {
    async get(key) {
      return values.has(key) ? { value: values.get(key) } : null
    },
  }

  const state = await readStoredIdentityState(metaDb)
  t.is(state.activeIdentity, identityA.publicKey)
  t.alike(await readStoredIdentityRecords(metaDb), [identityA], 'stale legacy ghost is ignored')
})
