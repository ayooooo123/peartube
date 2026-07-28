import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const appRoot = path.resolve(import.meta.dirname, '..')

const appUiStubPlugin = {
  name: 'app-ui-stubs',
  setup(context) {
    context.onResolve({ filter: /^@expo\/vector-icons$/ }, () => ({
      path: 'vector-icons',
      namespace: 'test-stub',
    }))
    context.onResolve({ filter: /^expo-router$/ }, () => ({
      path: 'expo-router',
      namespace: 'test-stub',
    }))
    context.onResolve({ filter: /^@\/lib\/AppContext$/ }, () => ({
      path: 'app-context',
      namespace: 'test-stub',
    }))
    context.onLoad({ filter: /^vector-icons$/, namespace: 'test-stub' }, () => ({
      contents: "import React from 'react'; export const Ionicons = (props) => React.createElement('span', props);",
      loader: 'js',
    }))
    context.onLoad({ filter: /^expo-router$/, namespace: 'test-stub' }, () => ({
      contents: 'export const useLocalSearchParams = () => ({}); export const useRouter = () => ({ back() {} });',
      loader: 'js',
    }))
    context.onLoad({ filter: /^app-context$/, namespace: 'test-stub' }, () => ({
      // Cards resolve swarm cover art through the context directly, so the stub
      // has to offer the context as well as the hook.
      contents: "import React from 'react'; export const AppContext = React.createContext(null); export const useApp = () => ({ rpc: {} });",
      loader: 'js',
    }))
  },
}

async function loadModule(entry) {
  const result = await build({
    entryPoints: [path.join(appRoot, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    alias: { 'react-native': 'react-native-web' },
    external: ['react', 'react-dom', 'react-native-web'],
    plugins: [appUiStubPlugin],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', baseUrl: appRoot, paths: { '@/*': ['./*'] } } },
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(appRoot, '.tmp-operability-ui-'))
  const output = path.join(directory, 'module.mjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?v=${Date.now()}-${Math.random()}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('selected and alternate sources explain rationale, conflicts, provenance, and offline state locally', async () => {
  const { normalizeSourceExplanation } = await loadModule('components/media/SourceSelector.tsx')
  const selected = normalizeSourceExplanation({
    selected: true,
    selectionReasonCodes: ['SELECTED_BY_HIGHEST_SCORE'],
    introductionPublisherIds: ['publisher-a'],
    introductionIndexIds: ['index-a'],
    claimConflictIds: ['conflict-a', 'conflict-b'],
    provenanceClaimIds: ['claim-a'],
    archiveState: 'pledged',
    cacheState: 'cached',
    availabilityState: 'available',
  }, 0)
  assert.equal(selected.label, 'Selected source')
  assert.match(selected.reason, /strongest local/i)
  assert.match(selected.introduction, /2 introduction paths/i)
  assert.match(selected.conflict, /2 conflicting claims/i)
  assert.match(selected.provenance, /1 provenance claim/i)
  assert.match(selected.offline, /available offline/i)
  assert.match(selected.archive, /pledge/i)

  const alternate = normalizeSourceExplanation({
    selected: false,
    rejectionReasonCodes: ['BLOCKED_BY_LOCAL_POLICY', 'STALE_AVAILABILITY', 'NO_AVAILABLE_COPY'],
    cacheState: 'not-cached',
    availabilityState: 'unavailable',
    stale: true,
    incomplete: true,
  }, 1)
  assert.equal(alternate.label, 'Alternate source 2')
  assert.match(alternate.reason, /local policy/i)
  assert.match(alternate.reason, /out of date/i)
  assert.match(alternate.availability, /unavailable/i)
  assert.match(alternate.offline, /not available offline/i)
  assert.match(alternate.completeness, /incomplete/i)
})

test('every backend source-selection reason code has deterministic local copy', async () => {
  const { normalizeSourceExplanation } = await loadModule('components/media/SourceSelector.tsx')
  const selectedCodes = [
    'SELECTED_BY_LOCAL_PREFERENCE',
    'SELECTED_BY_HIGHEST_SCORE',
    'SELECTED_BY_LOCAL_TIE_BREAK',
    'SELECTED_BY_LOCAL_ORDER',
  ]
  const alternateCodes = [
    'BLOCKED_BY_LOCAL_POLICY',
    'BLOCKED_BY_MODERATION',
    'STALE_AVAILABILITY',
    'INCOMPLETE_PUBLICATION',
    'NO_AVAILABLE_COPY',
    'UNAUTHORIZED_PUBLICATION',
    'UNCONFIRMED_AVAILABILITY',
    'DEPRIORITIZED_BY_LOCAL_PREFERENCE',
    'LOWER_LOCAL_SCORE',
    'LOCAL_SCORE_TIE_BREAK',
    'DEPRIORITIZED_BY_LOCAL_ORDER',
  ]

  for (const code of selectedCodes) {
    const first = normalizeSourceExplanation({ selectionReasonCodes: [code] }, 0, true)
    const second = normalizeSourceExplanation({ selectionReasonCodes: [code] }, 0, true)
    assert.equal(first.reason, second.reason)
    assert.doesNotMatch(first.reason, /source rules stored/i)
    assert.equal(first.reason.includes(code), false)
  }
  for (const code of alternateCodes) {
    const first = normalizeSourceExplanation({ rejectionReasonCodes: [code] }, 0, false)
    const second = normalizeSourceExplanation({ rejectionReasonCodes: [code] }, 0, false)
    assert.equal(first.reason, second.reason)
    assert.doesNotMatch(first.reason, /source rules stored/i)
    assert.equal(first.reason.includes(code), false)
  }
})

test('source explanations redact peer identifiers, provider names, unknown codes, and secrets', async () => {
  const { SourceSelector, normalizeSourceExplanation } = await loadModule('components/media/SourceSelector.tsx')
  const source = {
    publicationId: 'publication-peer-identifier',
    renditionId: 'rendition-peer-identifier',
    sourceProvider: 'provider-peer-name',
    publisherId: 'publisher-peer-identifier',
    selected: true,
    selectionReasonCodes: ['SECRET_ROOT_SEED_VALUE', 'toString', '__proto__'],
    introductionPublisherIds: ['publisher-introducer-pii'],
    introductionIndexIds: ['index-introducer-pii'],
    moderationFeedIds: ['moderation-peer-pii'],
    claimConflictIds: ['conflict-peer-pii'],
    provenanceClaimIds: ['provenance-peer-pii'],
    availabilityState: 'unknown',
  }
  const explanation = normalizeSourceExplanation(source, 0)
  const serialized = JSON.stringify(explanation)
  assert.equal(explanation.reason, 'Selected using source rules stored on this device.')
  const html = renderToStaticMarkup(React.createElement(SourceSelector, {
    entityId: 'entity-peer-identifier',
    sources: [source],
    selectedPublicationId: source.publicationId,
  }))
  for (const sensitive of [
    'publication-peer-identifier', 'rendition-peer-identifier', 'provider-peer-name',
    'publisher-peer-identifier', 'SECRET_ROOT_SEED_VALUE', 'publisher-introducer-pii',
    'index-introducer-pii', 'moderation-peer-pii', 'conflict-peer-pii',
    'provenance-peer-pii', 'entity-peer-identifier',
  ]) {
    assert.equal(serialized.includes(sensitive), false, `normalized explanation leaked ${sensitive}`)
    assert.equal(html.includes(sensitive), false, `rendered selector leaked ${sensitive}`)
  }
})

test('media playback source selection fails closed without backend authorization diagnostics', async () => {
  const { SourceSelector, isPublicationSourceSelectable } = await loadModule('components/media/SourceSelector.tsx')
  const { normalizeMediaEntityView } = await loadModule('components/routes/MediaEntityPage.tsx')
  const authorized = {
    publicationId: 'authorized-publication',
    renditionId: 'authorized-rendition',
    selected: true,
    selectionReasonCodes: ['SELECTED_BY_HIGHEST_SCORE'],
    rejectionReasonCodes: [],
    availabilityState: 'available',
  }
  const unsigned = {
    publicationId: 'unsigned-publication',
    renditionId: 'unsigned-rendition',
    selected: true,
    selectionReasonCodes: [],
    rejectionReasonCodes: ['UNAUTHORIZED_PUBLICATION'],
    availabilityState: 'available',
  }

  assert.equal(isPublicationSourceSelectable(authorized), true)
  assert.equal(isPublicationSourceSelectable({ ...authorized, rejectionReasonCodes: undefined }), false)
  assert.equal(isPublicationSourceSelectable(unsigned), false)
  assert.equal(normalizeMediaEntityView({
    entityId: 'work-a',
    sources: [unsigned],
    selectedPublicationId: unsigned.publicationId,
  }).selectedPublicationId, null)
  assert.equal(normalizeMediaEntityView({
    entityId: 'work-a',
    sources: [authorized],
    selectedPublicationId: authorized.publicationId,
  }).selectedPublicationId, authorized.publicationId)

  const html = renderToStaticMarkup(React.createElement(SourceSelector, {
    entityId: 'work-a',
    sources: [unsigned],
    selectedPublicationId: unsigned.publicationId,
    onSelectSource() {},
  }))
  assert.match(html, /no trusted playable source/i)
  assert.match(html, /source unavailable/i)
  assert.doesNotMatch(html, /currently selected/i)
})

test('publisher status loading uses only the injected RPC and sanitizes failures', async () => {
  const { loadPublisherDeviceStatus } = await loadModule('components/publisher/PublisherSecurityStatus.tsx')
  const calls = []
  const loaded = await loadPublisherDeviceStatus({
    async getPublisherDeviceStatus(request) {
      calls.push(request)
      return {
        success: true,
        status: 'authorized',
        canPublish: true,
        canPlayLocal: true,
        canExportLocal: true,
        canDeleteLocal: true,
        canRootTransition: true,
      }
    },
  })
  assert.deepEqual(calls, [{}])
  assert.equal(loaded.status, 'authorized')

  const failed = await loadPublisherDeviceStatus({
    async getPublisherDeviceStatus() {
      throw new Error('root-secret-value')
    },
  })
  assert.deepEqual(failed, {
    success: false,
    status: 'unable-to-publish',
    canPublish: false,
    canPlayLocal: false,
    canExportLocal: false,
    canDeleteLocal: false,
    canRootTransition: false,
  })
  assert.equal(JSON.stringify(failed).includes('root-secret-value'), false)
})

test('publisher status loading rejects malformed success values and privileged flags', async () => {
  const { loadPublisherDeviceStatus } = await loadModule('components/publisher/PublisherSecurityStatus.tsx')
  for (const success of [undefined, null, false, 'true', 1]) {
    const loaded = await loadPublisherDeviceStatus({
      async getPublisherDeviceStatus() {
        return {
          success,
          status: 'authorized',
          canPublish: true,
          canPlayLocal: true,
          canExportLocal: true,
          canDeleteLocal: true,
          canRootTransition: true,
        }
      },
    })
    assert.deepEqual(loaded, {
      success: false,
      status: 'unable-to-publish',
      canPublish: false,
      canPlayLocal: false,
      canExportLocal: false,
      canDeleteLocal: false,
      canRootTransition: false,
    })
  }
})

test('all five publisher device states have plain-language status without public-key or reason leakage', async () => {
  const { normalizePublisherDeviceStatus } = await loadModule('components/publisher/PublisherDeviceStatus.tsx')
  const expected = new Map([
    ['authorized', /authorized/i],
    ['stale', /out of date/i],
    ['revoked', /revoked/i],
    ['authority-lost', /authority.*no longer/i],
    ['unable-to-publish', /cannot publish/i],
  ])
  for (const [status, message] of expected) {
    const normalized = normalizePublisherDeviceStatus({
      success: true,
      status,
      reasonCode: `SENSITIVE_${status}`,
      publisherId: 'publisher-public-key-pii',
      devicePublicKey: 'device-public-key-pii',
      canPublish: status === 'authorized',
      canPlayLocal: true,
      canExportLocal: true,
      canDeleteLocal: true,
      canRootTransition: status === 'authorized',
    })
    assert.equal(normalized.status, status)
    assert.match(`${normalized.label} ${normalized.explanation}`, message)
    assert.equal(JSON.stringify(normalized).includes('publisher-public-key-pii'), false)
    assert.equal(JSON.stringify(normalized).includes('device-public-key-pii'), false)
    assert.equal(JSON.stringify(normalized).includes(`SENSITIVE_${status}`), false)
  }
})

test('prototype-colliding publisher reason codes remain redacted renderable text', async () => {
  const { PublisherDeviceStatus, normalizePublisherDeviceStatus } = await loadModule('components/publisher/PublisherDeviceStatus.tsx')
  for (const reasonCode of ['__proto__', 'constructor', 'toString']) {
    const status = {
      success: true,
      status: 'authorized',
      reasonCode,
      canPublish: false,
      canPlayLocal: true,
      canExportLocal: true,
      canDeleteLocal: true,
      canRootTransition: false,
    }
    const normalized = normalizePublisherDeviceStatus(status)
    assert.equal(normalized.detail, null)
    assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(PublisherDeviceStatus, { status })))
  }
})

test('publisher capability controls deny publish and root transition while retaining allowed local-media actions', async () => {
  const { PublisherDeviceStatus, normalizePublisherDeviceStatus } = await loadModule('components/publisher/PublisherDeviceStatus.tsx')
  const status = {
    success: true,
    status: 'revoked',
    reasonCode: 'DEVICE_REVOKED',
    canPublish: false,
    canPlayLocal: true,
    canExportLocal: true,
    canDeleteLocal: true,
    canRootTransition: false,
  }
  const normalized = normalizePublisherDeviceStatus(status)
  assert.deepEqual(normalized.actions, [
    { id: 'publish', label: 'Publish', allowed: false },
    { id: 'root-transition', label: 'Change publisher authority', allowed: false },
    { id: 'play-local', label: 'Play local media', allowed: true },
    { id: 'export-local', label: 'Export local media', allowed: true },
    { id: 'delete-local', label: 'Delete local media', allowed: true },
  ])
  const actionHandlers = {
    publish() {},
    'root-transition'() {},
    'play-local'() {},
    'export-local'() {},
    'delete-local'() {},
  }
  const html = renderToStaticMarkup(React.createElement(PublisherDeviceStatus, { status, actionHandlers }))
  assert.match(html, /<[^>]*(?=[^>]*data-testid="publisher-action-publish")(?=[^>]*aria-disabled="true")[^>]*>/)
  assert.match(html, /<[^>]*(?=[^>]*data-testid="publisher-action-root-transition")(?=[^>]*aria-disabled="true")[^>]*>/)
  assert.doesNotMatch(html, /<[^>]*(?=[^>]*data-testid="publisher-action-play-local")(?=[^>]*aria-disabled="true")[^>]*>/)
  assert.doesNotMatch(html, /<[^>]*(?=[^>]*data-testid="publisher-action-export-local")(?=[^>]*aria-disabled="true")[^>]*>/)
  assert.doesNotMatch(html, /<[^>]*(?=[^>]*data-testid="publisher-action-delete-local")(?=[^>]*aria-disabled="true")[^>]*>/)
})

test('non-authorized and unknown device states fail closed for privileged actions', async () => {
  const { normalizePublisherDeviceStatus } = await loadModule('components/publisher/PublisherDeviceStatus.tsx')
  for (const status of ['stale', 'revoked', 'authority-lost', 'unable-to-publish', 'future-state']) {
    const normalized = normalizePublisherDeviceStatus({
      success: true,
      status,
      canPublish: true,
      canRootTransition: true,
      canPlayLocal: true,
      canExportLocal: true,
      canDeleteLocal: true,
    })
    assert.equal(normalized.actions.find((action) => action.id === 'publish')?.allowed, false)
    assert.equal(normalized.actions.find((action) => action.id === 'root-transition')?.allowed, false)
    assert.equal(normalized.actions.find((action) => action.id === 'play-local')?.allowed, true)
    assert.equal(normalized.actions.find((action) => action.id === 'export-local')?.allowed, true)
    assert.equal(normalized.actions.find((action) => action.id === 'delete-local')?.allowed, true)
  }
})

test('publisher status snapshots invalidate every RPC identity transition', async () => {
  const { snapshotForPublisherStatusRpc } = await loadModule('components/publisher/PublisherSecurityStatus.tsx')
  const firstRpc = { async getPublisherDeviceStatus() { return { success: false } } }
  const replacementRpc = { async getPublisherDeviceStatus() { return { success: false } } }
  const authorized = { success: true, status: 'authorized', canPublish: true, canRootTransition: true }
  const authorizedSnapshot = { rpc: firstRpc, generation: 0, status: authorized }
  assert.equal(snapshotForPublisherStatusRpc(authorizedSnapshot, firstRpc), authorizedSnapshot)

  const replacementSnapshot = snapshotForPublisherStatusRpc(authorizedSnapshot, replacementRpc)
  assert.deepEqual(replacementSnapshot, { rpc: replacementRpc, generation: 1, status: null })
  const returningSnapshot = snapshotForPublisherStatusRpc(replacementSnapshot, firstRpc)
  assert.deepEqual(returningSnapshot, { rpc: firstRpc, generation: 2, status: null })
})

test('native and web media routes share one normalization path and render the same explanations', async () => {
  const native = await loadModule('app/media/[id].tsx')
  const web = await loadModule('app/media/[id].web.tsx')
  const entity = {
    entityId: 'work-a',
    title: 'Local title',
    sources: [{
      publicationId: 'pub-a',
      renditionId: 'rend-a',
      selected: true,
      selectionReasonCodes: ['SELECTED_BY_LOCAL_PREFERENCE'],
      cacheState: 'cached',
      availabilityState: 'available',
    }],
  }
  assert.deepEqual(native.normalizeMediaEntityView(entity, 'fallback'), web.normalizeMediaEntityView(entity, 'fallback'))
  const props = { id: 'fallback', entity }
  assert.equal(
    renderToStaticMarkup(React.createElement(native.default, props)),
    renderToStaticMarkup(React.createElement(web.default, props)),
  )
})
