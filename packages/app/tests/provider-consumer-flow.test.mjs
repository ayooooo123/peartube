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

test('progress copy, retention choice, cancellation, and completed-only playback are explicit', async () => {
  const flow = await loadFlow()
  assert.deepEqual(flow.RETENTION_CHOICES.map((choice) => choice.value), ['contribution-cache', 'archive-pin'])
  assert.equal(flow.acquisitionProgressLabel({ state: 'queued' }), 'Finding a peer…')
  assert.equal(flow.acquisitionProgressLabel({ state: 'acquiring', bytesAcquired: 50, expectedBytes: 100 }), 'Acquiring… 50%')
  assert.equal(flow.acquisitionProgressLabel({ state: 'verifying' }), 'Checking every block…')
  assert.equal(flow.acquisitionProgressLabel({ state: 'publishing' }), 'Making it playable…')
  assert.equal(flow.acquisitionCanPlay({ state: 'failed', publicationId: 'pub-1' }), false)
  assert.equal(flow.acquisitionCanPlay({ state: 'cancelled', publicationId: 'pub-1' }), false)
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

test('acquisition policy screen and route stay behind Developer Mode', () => {
  const screen = fs.readFileSync(path.join(appRoot, 'app/acquisition-settings.tsx'), 'utf8')
  const routes = fs.readFileSync(path.join(appRoot, 'lib/developer-mode-routes.ts'), 'utf8')
  assert.match(screen, /DeveloperModeGate/)
  assert.match(screen, /I consent to bounded media acquisition/)
  assert.match(screen, /acceptPublicRequests/)
  assert.match(routes, /['"]\/acquisition-settings['"]/)
})

test('terminal re-requests rotate idempotency while recoverable retries keep it', () => {
  const page = fs.readFileSync(path.join(appRoot, 'components/routes/MediaEntityPage.tsx'), 'utf8')
  assert.match(page, /acquisition\?\.state === 'cancelled'/)
  assert.match(page, /acquisition\?\.state === 'failed' && acquisition\.recoverable !== true/)
  assert.match(page, /idempotencyKey\.current = `app-\$\{Date\.now\(\)\}-\$\{acquisition\.acquisitionId\}`/)
})
