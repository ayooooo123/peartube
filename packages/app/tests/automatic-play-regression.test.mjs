import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

import {
  HARD_REJECTION_REASON_CODES,
  isMediaSourcePlayable,
  selectMediaSource,
  switchMediaSource,
} from '../lib/media-source-selection.js'

const appRoot = path.resolve(import.meta.dirname, '..')

const RANKING_REJECTION_CODES = [
  'DEPRIORITIZED_BY_LOCAL_PREFERENCE',
  'LOWER_LOCAL_SCORE',
  'LOCAL_SCORE_TIE_BREAK',
  'DEPRIORITIZED_BY_LOCAL_ORDER',
]

const SELECTION_CODES = [
  'SELECTED_BY_LOCAL_PREFERENCE',
  'SELECTED_BY_HIGHEST_SCORE',
  'SELECTED_BY_LOCAL_TIE_BREAK',
  'SELECTED_BY_LOCAL_ORDER',
]

async function loadSourceExplanation() {
  const result = await build({
    entryPoints: [path.join(appRoot, 'components/media/SourceExplanation.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['react', 'react/jsx-runtime'],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(appRoot, '.tmp-automatic-play-'))
  const output = path.join(directory, 'module.mjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(pathToFileURL(output).href)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// The shape the backend playback selector puts on the wire: one hard-gate
// verdict (`eligible`), one winner (`selected`), one score, and the codes that
// explain both.
function backendSource(overrides = {}) {
  return {
    publicationId: 'pub-default',
    renditionId: 'rend-default',
    publisherId: 'publisher-default',
    availabilityState: 'available',
    selected: false,
    eligible: true,
    selectionReasonCodes: [],
    rejectionReasonCodes: [],
    formatSupported: true,
    ...overrides,
  }
}

// Play is one action: resolve the entity, take the source the backend already
// chose, and start. There is no picker in this path.
function play(entity) {
  const selection = selectMediaSource(entity)
  return {
    playbackRef: selection.selectedSource?.playbackRef || null,
    unavailableReason: selection.unavailableReason,
    selection,
  }
}

test('one Play action resolves to the backend-selected source without touching the picker', () => {
  const entity = {
    localEntityId: 'work:movie:auto',
    sources: [
      backendSource({ publicationId: 'pub-a', renditionId: 'rend-a', score: 800, rejectionReasonCodes: ['LOWER_LOCAL_SCORE'] }),
      backendSource({
        publicationId: 'pub-b',
        renditionId: 'rend-b',
        score: 640,
        selected: true,
        selectionReasonCodes: ['SELECTED_BY_LOCAL_PREFERENCE'],
      }),
    ],
  }

  const first = play(entity)
  assert.deepEqual(first.playbackRef, { publicationId: 'pub-b', renditionId: 'rend-b' })
  assert.equal(first.unavailableReason, null)
  assert.equal(first.selection.selectedSource.selectionReasonCodes[0], 'SELECTED_BY_LOCAL_PREFERENCE')

  // Same inputs, same Play target: nothing about the resolution is stateful.
  assert.deepEqual(play(entity).playbackRef, first.playbackRef)
})

test('an ineligible source is never selected even when it would score best', () => {
  const selection = selectMediaSource({
    localEntityId: 'work:movie:gated',
    sources: [
      backendSource({
        publicationId: 'pub-best-but-gated',
        renditionId: 'rend-gated',
        eligible: false,
        score: 900,
        localComplete: true,
        availabilityStatus: 'local',
      }),
      backendSource({ publicationId: 'pub-plain', renditionId: 'rend-plain', score: 10 }),
    ],
  })

  assert.equal(selection.selectedSource.publicationId, 'pub-plain')
  assert.equal(isMediaSourcePlayable(backendSource({ eligible: false })), false)
  // Ineligible sources stay visible as alternates, but rank behind every
  // eligible one so failover can never walk into them.
  assert.deepEqual(
    selection.alternateSources.map((source) => source.publicationId),
    ['pub-best-but-gated'],
  )
  assert.equal(selection.alternateSources[0].eligible, false)
})

test('the backend selection wins over the local legacy heuristic ordering', () => {
  const selection = selectMediaSource({
    localEntityId: 'work:movie:override',
    sources: [
      // Everything the on-device heuristic loves: a complete local copy, a
      // verified manifest, and the highest rendition.
      backendSource({
        publicationId: 'pub-heuristic-favourite',
        renditionId: 'rend-2160',
        localComplete: true,
        availabilityStatus: 'local',
        verified: true,
        height: 2160,
      }),
      backendSource({
        publicationId: 'pub-backend-choice',
        renditionId: 'rend-720',
        height: 720,
        selected: true,
        selectionReasonCodes: ['SELECTED_BY_HIGHEST_SCORE'],
      }),
    ],
  })

  assert.equal(selection.selectedSource.publicationId, 'pub-backend-choice')
  assert.equal(selection.sources[0].publicationId, 'pub-backend-choice')
  assert.equal(selection.alternateSources[0].publicationId, 'pub-heuristic-favourite')
})

test('every hard rejection code makes a source unplayable and unselectable', () => {
  assert.ok(HARD_REJECTION_REASON_CODES.length > 0)
  for (const code of HARD_REJECTION_REASON_CODES) {
    const gated = backendSource({
      publicationId: 'pub-gated',
      renditionId: 'rend-gated',
      score: 5000,
      selected: true,
      rejectionReasonCodes: [code],
    })
    assert.equal(isMediaSourcePlayable(gated), false, `${code} must not be playable`)

    const selection = selectMediaSource({
      localEntityId: 'work:movie:hard-gate',
      sources: [gated, backendSource({ publicationId: 'pub-open', renditionId: 'rend-open', score: 1 })],
    })
    assert.equal(selection.selectedSource.publicationId, 'pub-open', `${code} must not win selection`)

    assert.deepEqual(
      switchMediaSource({ entityId: 'work:movie:hard-gate' }, gated),
      { entityId: 'work:movie:hard-gate', sourceSwitchError: 'source-not-playable' },
      `${code} must not be reachable through an explicit switch`,
    )
  }
})

test('no eligible source yields no selection and a structured reason instead of a guess', () => {
  const selection = selectMediaSource({
    localEntityId: 'work:movie:nothing',
    sources: [
      backendSource({ publicationId: 'pub-drm', renditionId: 'rend-drm', eligible: false, rejectionReasonCodes: ['UNSUPPORTED_DRM'] }),
      backendSource({ publicationId: 'pub-gone', renditionId: 'rend-gone', eligible: false, rejectionReasonCodes: ['NO_AVAILABLE_COPY'] }),
    ],
  })

  assert.equal(selection.selectedSource, null)
  assert.equal(selection.unavailableReason, 'no-playable-source')
  assert.equal(selection.sourceCount, 2)
  assert.equal(selection.alternateSources.length, 2, 'rejected sources stay visible with their reasons')
})

test('every reason code renders one distinct, honest explanation', async () => {
  const { normalizeSourceExplanation } = await loadSourceExplanation()
  const rendered = []

  for (const code of SELECTION_CODES) {
    const explanation = normalizeSourceExplanation({ selectionReasonCodes: [code] }, 0, true)
    assert.ok(explanation.reason.length > 0, `${code} needs copy`)
    assert.doesNotMatch(explanation.reason, /source rules stored/i, `${code} fell back to generic copy`)
    assert.equal(explanation.reason.includes(code), false, `${code} leaked its raw code`)
    rendered.push(explanation.reason)
  }

  for (const code of [...HARD_REJECTION_REASON_CODES, ...RANKING_REJECTION_CODES]) {
    const explanation = normalizeSourceExplanation({ rejectionReasonCodes: [code] }, 0, false)
    assert.ok(explanation.reason.length > 0, `${code} needs copy`)
    assert.doesNotMatch(explanation.reason, /source rules stored/i, `${code} fell back to generic copy`)
    assert.equal(explanation.reason.includes(code), false, `${code} leaked its raw code`)
    rendered.push(explanation.reason)
  }

  assert.equal(new Set(rendered).size, rendered.length, 'each reason code needs its own explanation')

  // A hard gate says "this cannot play here"; a ranking loss says "another
  // source was better". Viewers have to be able to tell those apart.
  for (const code of HARD_REJECTION_REASON_CODES) {
    assert.match(
      normalizeSourceExplanation({ rejectionReasonCodes: [code] }, 0, false).reason,
      /^Cannot play/,
      `${code} is a hard gate and must read as one`,
    )
  }
  for (const code of RANKING_REJECTION_CODES) {
    assert.match(
      normalizeSourceExplanation({ rejectionReasonCodes: [code] }, 0, false).reason,
      /^Playable, but /,
      `${code} is a ranking loss, not a hard gate`,
    )
  }

  // Reachability is a local, expiring observation. Nothing here may read as a
  // durability promise or a service level.
  assert.doesNotMatch(rendered.join(' '), /guarantee|always|uptime|SLA/i)
})

test('device capability gates and peer reachability gates read differently', async () => {
  const { normalizeSourceExplanation } = await loadSourceExplanation()
  const reason = (code) => normalizeSourceExplanation({ rejectionReasonCodes: [code] }, 0, false).reason

  for (const code of ['UNSUPPORTED_DRM', 'UNSUPPORTED_CODEC', 'UNSUPPORTED_CONTAINER']) {
    assert.match(reason(code), /this device/i, `${code} is about this device`)
  }
  for (const code of ['NO_AVAILABLE_COPY', 'STALE_AVAILABILITY', 'UNCONFIRMED_AVAILABILITY']) {
    const copy = reason(code)
    assert.match(copy, /peer/i, `${code} is about current peer reachability`)
    assert.doesNotMatch(copy, /gone|deleted|lost|removed/i, `${code} must not imply the title is gone for good`)
  }
})

const { startMediaPlayback } = await import('../components/routes/media-entity-loaders.js')

function playbackRpc(response) {
  const calls = []
  return {
    calls,
    async prepareMediaPlayback(request) {
      calls.push(request)
      return typeof response === 'function' ? response(request) : response
    },
  }
}

test('Play asks the backend to prepare, and never sends a source it did not choose', async () => {
  const rpc = playbackRpc({
    success: true,
    publicationId: 'pub-a',
    renditionId: 'rendition-a',
    coreKey: 'a'.repeat(64),
    attempts: [{ publicationId: 'pub-a', errorCode: null }],
    sources: [{ publicationId: 'pub-a', selected: true, eligible: true }],
  })

  const prepared = await startMediaPlayback({ rpc, entityId: 'work:movie-1' })
  assert.deepEqual(rpc.calls, [{ entityId: 'work:movie-1' }], 'Play sends only the entity; the backend selects')
  assert.equal(prepared.publicationId, 'pub-a')
  assert.equal(prepared.renditionId, 'rendition-a')
})

test('Play reports the source that actually started after backend failover', async () => {
  const rpc = playbackRpc({
    success: true,
    publicationId: 'pub-b',
    renditionId: 'rendition-b',
    attempts: [
      { publicationId: 'pub-a', errorCode: 'PEER_DISCONNECT' },
      { publicationId: 'pub-b', errorCode: null },
    ],
    sources: [{ publicationId: 'pub-b', selected: true, eligible: true }],
  })

  const prepared = await startMediaPlayback({ rpc, entityId: 'work:movie-1' })
  assert.equal(prepared.publicationId, 'pub-b', 'the app follows the failover, it does not re-pick')
  assert.deepEqual(prepared.attempts.map(attempt => attempt.errorCode), ['PEER_DISCONNECT', null])
})

test('an Other Sources override travels as an explicit request, not a local switch', async () => {
  const rpc = playbackRpc({ success: true, publicationId: 'pub-c', renditionId: 'rendition-c' })
  await startMediaPlayback({ rpc, entityId: 'work:movie-1', publicationId: 'pub-c' })
  assert.deepEqual(rpc.calls, [{ entityId: 'work:movie-1', publicationId: 'pub-c' }])
})

test('a failed Play surfaces the structured reason instead of falling back to a guess', async () => {
  const rpc = playbackRpc({
    success: false,
    errorCode: 'AVAILABILITY_BOUNDARY',
    error: 'Unavailable - no peer currently serves the required ranges.',
    attempts: [{ publicationId: 'pub-a', errorCode: 'PEER_TIMEOUT' }],
    sources: [],
  })

  await assert.rejects(
    () => startMediaPlayback({ rpc, entityId: 'work:movie-1' }),
    (error) => {
      assert.equal(error.code, 'AVAILABILITY_BOUNDARY')
      assert.match(error.message, /no peer currently serves/i)
      assert.deepEqual(error.attempts.map(attempt => attempt.errorCode), ['PEER_TIMEOUT'])
      return true
    }
  )
})

test('Play refuses to run against a host that does not expose the preparation RPC', async () => {
  await assert.rejects(
    () => startMediaPlayback({ rpc: {}, entityId: 'work:movie-1' }),
    /prepareMediaPlayback/
  )
})
