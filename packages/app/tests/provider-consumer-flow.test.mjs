import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const appRoot = path.resolve(import.meta.dirname, '..')

async function loadFlow() {
  const source = fs.readFileSync(path.join(appRoot, 'lib/provider-consumer-flow.ts'), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}#${Math.random()}`)
}

test('published hits play directly while misses resolve to an explicit request', async () => {
  const flow = await loadFlow()
  const published = await flow.resolveProviderHit({
    resolveProviderRef: async () => { throw new Error('published hits must not resolve') },
  }, {
    resolutionRef: 'published-ref', title: 'Published', published: true, acquirable: false,
    entityId: 'work-1', publicationId: 'pub-1',
  })
  assert.deepEqual(published, { kind: 'published', entityId: 'work-1', publicationId: 'pub-1' })

  const local = await flow.resolveProviderHit({
    resolveProviderRef: async () => { throw new Error('local entity hits must not resolve') },
  }, {
    resolutionRef: 'local-col-ref', title: 'Collection', published: false, acquirable: false,
    localEntity: true, entityId: 'col-1', mediaKind: 'collection',
  })
  assert.deepEqual(local, { kind: 'local', entityId: 'col-1', entityKind: 'collection' })

  const requested = await flow.resolveProviderHit({
    resolveProviderRef: async () => ({
      success: true,
      resolution: {
        schemaVersion: 1, resolutionRef: 'miss-ref', publisherId: 'publisher-1', title: 'Missing',
        published: false, acquirable: true,
      },
    }),
  }, { resolutionRef: 'miss-ref', title: 'Missing', published: false, acquirable: true })
  assert.equal(requested.kind, 'request')
})

test('retention, bounded acquisition progress, and playability remain distinct', async () => {
  const flow = await loadFlow()
  assert.deepEqual(
    new Set(flow.RETENTION_CHOICES.map(choice => choice.value)),
    new Set(['contribution-cache', 'archive-pin']),
  )
  assert.match(flow.acquisitionProgressLabel({ state: 'acquiring', bytesAcquired: 5, expectedBytes: 10 }), /50%$/)
  assert.match(flow.acquisitionProgressLabel({ state: 'acquiring', bytesAcquired: 12, expectedBytes: 10 }), /100%$/)
  assert.doesNotMatch(flow.acquisitionProgressLabel({ state: 'acquiring', bytesAcquired: 5, expectedBytes: null }), /%/)
  assert.equal(flow.acquisitionCanPlay({ state: 'failed', publicationId: 'pub-1' }), false)
  assert.equal(flow.acquisitionCanPlay({ state: 'cancelled', publicationId: 'pub-1' }), false)
  assert.equal(flow.acquisitionCanPlay({ state: 'completed', publicationId: null }), false)
  assert.equal(flow.acquisitionCanPlay({ state: 'completed', publicationId: 'pub-1' }), true)
})

test('completed acquisition reloads publication before media and rejects every other state', async () => {
  const flow = await loadFlow()
  const calls = []
  const provider = {
    getPublication: async ({ publicationId }) => {
      calls.push(`publication:${publicationId}`)
      return { success: true, publication: { publicationId, entityId: 'work-1' } }
    },
  }
  await flow.reloadCompletedAcquisition({
    provider,
    acquisition: { state: 'completed', publicationId: 'pub-1' },
    loadEntity: async (entityId) => { calls.push(`entity:${entityId}`); return { entityId } },
  })
  assert.deepEqual(calls, ['publication:pub-1', 'entity:work-1'])
  for (const state of ['queued', 'acquiring', 'verifying', 'publishing', 'failed', 'cancelled']) {
    await assert.rejects(() => flow.reloadCompletedAcquisition({
      provider, acquisition: { state, publicationId: 'pub-1' }, loadEntity: async () => ({}),
    }), /not completed/)
  }
})
