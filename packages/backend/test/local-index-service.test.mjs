import test from 'brittle'

import { createLocalIndexService } from '../src/indexer/local-service.js'

const QUERY_ID_A = '11'.repeat(32)
const QUERY_ID_B = '22'.repeat(32)
const PUBLISHER = '33'.repeat(32)

function request(overrides = {}) {
  return {
    queryId: QUERY_ID_A,
    selectors: [{ type: 'exact-external-ref', namespace: 'tmdb', identifier: 'show:95350:s1:e2' }],
    limit: 1,
    cursor: null,
    sourceRevision: null,
    deadlineMs: 5_000,
    ...overrides,
  }
}

function randomSource() {
  let value = 0
  return size => Buffer.alloc(size, ++value)
}

test('local index service maps store rows and carries bounded pagination', async t => {
  const calls = []
  const index = {
    async queryIndexPage(input) {
      calls.push(input)
      const second = input.continuation != null
      return {
        results: [{
          namespace: 'tmdb',
          normalizedIdentifier: second ? 'show:95350:s1:e3' : 'show:95350:s1:e2',
          publisherId: PUBLISHER,
          sourceRecordRef: second ? 'claim-2' : 'claim-1',
          entityKind: 'work',
          entityId: second ? '55'.repeat(32) : '44'.repeat(32),
          evidenceWeight: 10,
        }],
        continuation: second ? null : { selectorIndex: 0, after: { marker: 'next' } },
        sourceRevision: '0:9',
      }
    },
  }
  const service = createLocalIndexService({ index, randomBytes: randomSource(), now: () => 1_700_000_000_000 })

  const first = await service.queryIndexService({ query: request() })
  t.is(first.queryId, QUERY_ID_A)
  t.is(first.results[0].type, 'external-ref')
  t.is(first.results[0].identifier, 'show:95350:s1:e2')
  t.ok(first.nextCursor)

  const second = await service.queryIndexService({
    query: request({ queryId: QUERY_ID_B, cursor: first.nextCursor, sourceRevision: first.sourceRevision }),
  })
  t.is(second.results[0].identifier, 'show:95350:s1:e3')
  t.is(second.nextCursor, null)
  t.alike(calls[1].continuation, { selectorIndex: 0, after: { marker: 'next' } })
  t.is(calls[1].sourceRevision, '0:9')

  service.close()
  await t.exception(service.queryIndexService({ query: request() }), /closed/)
})
