import test from 'brittle'

import { createProviderPolicyAdapter } from '../src/orchestrator.js'

// `/api/v2/policy` had no adapter at all, so an operator asking a relay for its
// posture got POLICY_UNAVAILABLE. The seam below is the whole fix: it translates
// the provider's contract onto the node's own policy surface and invents
// nothing.
function policyApi(overrides = {}) {
  let policy = { participationMode: 'balanced', archiveEnabled: true }
  return {
    async getNetworkPolicy() { return { success: true, policy } },
    async setNetworkPolicy(patch) {
      policy = { ...policy, ...patch }
      return { success: true, policy }
    },
    ...overrides,
  }
}

test('a node without a policy surface gets no adapter rather than a broken one', (t) => {
  t.is(createProviderPolicyAdapter(null), null)
  t.is(createProviderPolicyAdapter({}), null)
  t.is(createProviderPolicyAdapter({ getNetworkPolicy() {} }), null, 'a half-implemented surface is not an adapter')
})

test('the adapter reads the node policy and counts the writes it accepted', async (t) => {
  const adapter = createProviderPolicyAdapter(policyApi())
  t.is(adapter.getRevision(), 0)
  t.alike(await adapter.getPolicy(), { participationMode: 'balanced', archiveEnabled: true })

  const next = await adapter.setPolicy({ participationMode: 'conservative' }, { expectedRevision: 0 })
  t.is(next.participationMode, 'conservative', 'the write reaches the node surface')
  t.is(adapter.getRevision(), 1, 'and the revision moves so a stale writer is caught')
  t.is((await adapter.getPolicy()).participationMode, 'conservative')
})

test('a write against a revision the caller never saw is refused', async (t) => {
  const adapter = createProviderPolicyAdapter(policyApi())
  await adapter.setPolicy({ archiveEnabled: false }, { expectedRevision: 0 })

  await t.exception(
    adapter.setPolicy({ archiveEnabled: true }, { expectedRevision: 0 }),
    /revision changed/,
    'the second writer read revision 0 and lost the race'
  )
  t.is((await adapter.getPolicy()).archiveEnabled, false, 'the refused write changed nothing')
  t.is(adapter.getRevision(), 1, 'and a refusal does not advance the revision')
})

test('a rejection from the node surface reaches the caller with its own code', async (t) => {
  const adapter = createProviderPolicyAdapter(policyApi({
    async setNetworkPolicy() {
      return { success: false, errorCode: 'INVALID_POLICY', error: 'uploadCeilingBytes is invalid', unsupportedField: 'uploadCeilingBytes' }
    },
  }))

  const failure = await adapter.setPolicy({ uploadCeilingBytes: -1 }, { expectedRevision: 0 }).catch(error => error)
  t.is(failure.code, 'INVALID_POLICY')
  t.is(failure.field, 'uploadCeilingBytes', 'the field the node named survives the translation')
  t.is(adapter.getRevision(), 0, 'a rejected write is not a write')
})
