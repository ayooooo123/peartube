import test from 'brittle'
import { createPickerState, reducePicker } from '../src/add/picker-state.js'

const pane = (state) => state.screens[state.screen]

function replaceResults (state, requestId, items) {
  state = reducePicker(state, { type: 'results.request', requestId })
  return reducePicker(state, { type: 'results.replace', requestId, items })
}

function choose (state, items, index = 0, requestId = state.latestRequestId + 1) {
  state = replaceResults(state, requestId, items)
  if (index !== 0) state = reducePicker(state, { type: 'selection.move', delta: index })
  return reducePicker(state, { type: 'step.confirm' })
}

test('initial state is data-only and unknown actions are exact no-ops', (t) => {
  const state = createPickerState({ query: 'breaking' })

  t.alike(state, {
    screen: 'search',
    screens: {
      search: {
        input: { field: 'query', value: 'breaking', cursor: 8 },
        results: { status: 'idle', requestId: null, items: [], error: null },
        selection: { index: 0, selected: [] }
      }
    },
    history: [],
    choices: {},
    latestRequestId: 0,
    progress: null,
    result: null,
    exitConfirm: null
  })
  t.is(reducePicker(state, { type: 'future.action', payload: {} }), state)
  t.is(JSON.stringify(JSON.parse(JSON.stringify(state))), JSON.stringify(state))
})

test('query editing inserts at the cursor and supports deterministic cursor deletion edits', (t) => {
  let state = createPickerState({ query: 'abc' })

  state = reducePicker(state, { type: 'query.cursor', delta: -2 })
  state = reducePicker(state, { type: 'query.insert', text: 'X' })
  t.alike(pane(state).input, { field: 'query', value: 'aXbc', cursor: 2 })

  state = reducePicker(state, { type: 'query.deleteBackward' })
  state = reducePicker(state, { type: 'query.deleteForward' })
  t.alike(pane(state).input, { field: 'query', value: 'ac', cursor: 1 })

  state = reducePicker(state, { type: 'query.home' })
  state = reducePicker(state, { type: 'query.insert', text: '>' })
  state = reducePicker(state, { type: 'query.end' })
  state = reducePicker(state, { type: 'query.insert', text: '<' })
  t.alike(pane(state).input, { field: 'query', value: '>ac<', cursor: 4 })
})

test('selection movement wraps at both boundaries and is an exact no-op for empty results', (t) => {
  let state = createPickerState()
  state = replaceResults(state, 1, [
    { id: 'a', value: 'A' },
    { id: 'b', value: 'B' },
    { id: 'c', value: 'C' }
  ])

  state = reducePicker(state, { type: 'selection.move', delta: -1 })
  t.is(pane(state).selection.index, 2)
  state = reducePicker(state, { type: 'selection.move', delta: 1 })
  t.is(pane(state).selection.index, 0)
  state = reducePicker(state, { type: 'selection.move', delta: 4 })
  t.is(pane(state).selection.index, 1)

  state = replaceResults(state, 2, [])
  t.is(pane(state).selection.index, 0)
  t.is(reducePicker(state, { type: 'selection.move', delta: 1 }), state)
})

test('Tab completion replaces the active field with the highlighted data candidate', (t) => {
  let state = createPickerState({ query: 'bre' })
  state = replaceResults(state, 1, [
    { id: 'wire', label: 'The Wire', value: 'the wire' },
    { id: 'breaking', label: 'Breaking Bad', value: 'breaking bad' }
  ])
  state = reducePicker(state, { type: 'selection.move', delta: 1 })
  state = reducePicker(state, { type: 'selection.complete' })

  t.alike(pane(state).input, { field: 'query', value: 'breaking bad', cursor: 12 })
  t.is(pane(state).selection.index, 1)
})

test('Tab completion accepts filesystem paths supplied as plain candidate data', (t) => {
  let state = createPickerState({ screen: 'movieSource', field: 'source', query: '/media/Bre' })
  state = replaceResults(state, 1, [
    { id: 'file-1', kind: 'filesystem', path: '/media/Breaking Bad (2008).mkv' }
  ])
  state = reducePicker(state, { type: 'selection.complete' })

  t.alike(pane(state).input, {
    field: 'source',
    value: '/media/Breaking Bad (2008).mkv',
    cursor: 30
  })
})

test('requests are monotonic and stale responses are ignored byte-for-byte', (t) => {
  let state = createPickerState()
  state = reducePicker(state, { type: 'results.request', requestId: 10 })
  t.alike(pane(state).results, {
    status: 'loading',
    requestId: 10,
    items: [],
    error: null
  })

  for (const stale of [
    { type: 'results.replace', requestId: 9, items: [{ id: 'stale' }] },
    { type: 'results.error', requestId: 9, error: 'stale error' },
    { type: 'results.request', requestId: 9 },
    { type: 'results.request', requestId: 10 }
  ]) {
    const bytes = JSON.stringify(state)
    const next = reducePicker(state, stale)
    t.is(next, state)
    t.is(JSON.stringify(next), bytes)
  }

  state = reducePicker(state, {
    type: 'results.replace',
    requestId: 10,
    items: [{ id: 'current', value: 'Current' }]
  })
  t.is(pane(state).results.status, 'ready')
  t.is(state.latestRequestId, 10)

  state = reducePicker(state, { type: 'results.request', requestId: 11 })
  state = reducePicker(state, { type: 'results.error', requestId: 11, error: 'offline' })
  t.alike(pane(state).results, {
    status: 'error',
    requestId: 11,
    items: [{ id: 'current', value: 'Current' }],
    error: 'offline'
  })

  const duplicateRetry = reducePicker(state, { type: 'results.retry', requestId: 11 })
  t.is(duplicateRetry, state)
  state = reducePicker(state, { type: 'results.retry', requestId: 12 })
  t.is(pane(state).results.status, 'loading')
  t.is(pane(state).results.requestId, 12)
  t.is(state.latestRequestId, 12)
})

test('a request settles exactly once and ignores late responses with the same ID', (t) => {
  let state = reducePicker(createPickerState(), { type: 'results.request', requestId: 1 })
  state = reducePicker(state, {
    type: 'results.replace',
    requestId: 1,
    items: [{ id: 'first', value: 'First' }]
  })
  const settledBytes = JSON.stringify(state)

  for (const late of [
    { type: 'results.replace', requestId: 1, items: [{ id: 'second', value: 'Second' }] },
    { type: 'results.error', requestId: 1, error: 'late failure' }
  ]) {
    const next = reducePicker(state, late)
    t.is(next, state)
    t.is(JSON.stringify(next), settledBytes)
  }
})

test('malformed result payloads do not consume the active request', (t) => {
  const state = reducePicker(createPickerState(), { type: 'results.request', requestId: 1 })
  const stateBytes = JSON.stringify(state)

  for (const action of [
    { type: 'results.replace', requestId: 1 },
    { type: 'results.replace', requestId: 1, items: { id: 'object' } },
    { type: 'results.replace', requestId: 1, items: 'string' }
  ]) {
    const next = reducePicker(state, action)
    t.is(next, state)
    t.is(JSON.stringify(next), stateBytes)
  }
})

test('result replacement keeps the highlight valid and filters unavailable multi-selections', (t) => {
  let state = createPickerState({ screen: 'episodeSelection', field: 'episode' })
  state = replaceResults(state, 1, [
    { id: 'e1', value: 'Episode 1' },
    { id: 'e2', value: 'Episode 2' },
    { id: 'e3', value: 'Episode 3' }
  ])
  state = reducePicker(state, { type: 'selection.toggle' })
  state = reducePicker(state, { type: 'selection.move', delta: 2 })
  state = reducePicker(state, { type: 'selection.toggle' })
  const selectedBeforeReplacement = pane(state).selection.selected
  t.is(selectedBeforeReplacement.length, 2)
  t.is(selectedBeforeReplacement[0] === selectedBeforeReplacement[1], false)

  state = reducePicker(state, { type: 'results.request', requestId: 2 })
  state = reducePicker(state, {
    type: 'results.replace',
    requestId: 2,
    items: [
      { id: 'e3', value: 'Episode 3' },
      { id: 'e4', value: 'Episode 4' }
    ]
  })
  t.alike(pane(state).selection, { index: 1, selected: [selectedBeforeReplacement[1]] })
})

test('result replacement filters null and malformed candidates without mutating the action', (t) => {
  const items = [
    null,
    'not candidate data',
    42,
    [],
    {},
    { id: 'valid', value: 'Valid candidate' }
  ]
  const action = { type: 'results.replace', requestId: 1, items }
  const actionBytes = JSON.stringify(action)
  let state = reducePicker(createPickerState(), { type: 'results.request', requestId: 1 })

  state = reducePicker(state, action)

  t.is(JSON.stringify(action), actionBytes)
  t.alike(pane(state).results.items, [{ id: 'valid', value: 'Valid candidate' }])
  t.alike(pane(state).selection, { index: 0, selected: [] })
  t.is(reducePicker(state, { type: 'selection.move', delta: 1 }), state)
})

for (const screen of ['episodeSelection', 'bulkMapping']) {
  test(`${screen} deduplicates candidate identities before multi-selection`, (t) => {
    let state = createPickerState({ screen })
    state = replaceResults(state, 1, [
      { id: 'duplicate', value: 'First row wins' },
      { id: 'duplicate', value: 'Second row is discarded' },
      { id: 'unique', value: 'Unique row' }
    ])

    t.alike(pane(state).results.items, [
      { id: 'duplicate', value: 'First row wins' },
      { id: 'unique', value: 'Unique row' }
    ])
    state = reducePicker(state, { type: 'selection.toggle' })
    state = reducePicker(state, { type: 'step.confirm' })

    const selected = screen === 'episodeSelection'
      ? state.choices.episodes
      : state.choices.bulkMapping
    t.is(selected.length, 1)
    t.alike(selected[0], { id: 'duplicate', value: 'First row wins' })
  })
}

test('TV path preserves query, season, and stable episode selections while stepping back', (t) => {
  let state = createPickerState({ query: 'breaking bad' })
  state = choose(state, [{ id: 'tv-1396', kind: 'tv', value: 'Breaking Bad' }])
  t.is(state.screen, 'tvSeason')

  state = choose(state, [{ id: 'season-2', number: 2, value: 'Season 2' }])
  t.is(state.screen, 'episodeSelection')

  state = replaceResults(state, 3, [
    { id: 's2e1', number: 1, value: 'Episode 1' },
    { id: 's2e2', number: 2, value: 'Episode 2' },
    { id: 's2e3', number: 3, value: 'Episode 3' }
  ])
  state = reducePicker(state, { type: 'selection.toggle' })
  state = reducePicker(state, { type: 'selection.move', delta: 2 })
  state = reducePicker(state, { type: 'selection.toggle' })
  const selectedEpisodes = pane(state).selection.selected
  state = reducePicker(state, { type: 'step.confirm' })
  t.is(state.screen, 'sourceSelection')
  t.alike(state.choices.episodes.map((episode) => episode.id), ['s2e1', 's2e3'])

  state = reducePicker(state, { type: 'step.back' })
  t.is(state.screen, 'episodeSelection')
  t.alike(pane(state).selection, { index: 2, selected: selectedEpisodes })
  state = reducePicker(state, { type: 'step.back' })
  t.is(state.screen, 'tvSeason')
  t.is(state.choices.tvSeason.id, 'season-2')
  state = reducePicker(state, { type: 'step.back' })
  t.is(state.screen, 'search')
  t.is(pane(state).input.value, 'breaking bad')
})

test('changing an upstream TV season clears dependent state but reselecting the same season preserves it', (t) => {
  let state = createPickerState({ screen: 'tvSeason' })
  state = replaceResults(state, 1, [
    { id: 'season-1', value: 'Season 1' },
    { id: 'season-2', value: 'Season 2' }
  ])
  state = reducePicker(state, { type: 'step.confirm' })
  state = replaceResults(state, 2, [{ id: 's1e1', value: 'S1E1' }])
  state = reducePicker(state, { type: 'selection.toggle' })
  const selectedSeasonOne = pane(state).selection.selected

  state = reducePicker(state, { type: 'step.back' })
  state = reducePicker(state, { type: 'step.confirm' })
  t.is(state.screen, 'episodeSelection')
  t.alike(pane(state).selection.selected, selectedSeasonOne)

  state = reducePicker(state, { type: 'step.back' })
  state = reducePicker(state, { type: 'selection.move', delta: 1 })
  state = reducePicker(state, { type: 'step.confirm' })
  t.is(state.screen, 'episodeSelection')
  t.alike(pane(state).results, {
    status: 'idle',
    requestId: null,
    items: [],
    error: null
  })
  t.alike(pane(state).selection, { index: 0, selected: [] })
  t.is(state.choices.episodes, undefined)

  const emptyConfirm = reducePicker(state, { type: 'step.confirm' })
  t.is(emptyConfirm, state)
  t.is(reducePicker(emptyConfirm, { type: 'step.confirm' }), state)

  state = replaceResults(state, 3, [{ id: 's2e1', value: 'S2E1' }])
  state = reducePicker(state, { type: 'selection.toggle' })
  const selectedSeasonTwo = pane(state).selection.selected
  state = reducePicker(state, { type: 'step.back' })
  state = reducePicker(state, { type: 'step.confirm' })
  t.alike(pane(state).selection.selected, selectedSeasonTwo)
})

test('candidate identity namespaces mixed kinds and invalidates only changed branches', (t) => {
  const mixed = [
    { id: 42, kind: 'tv', provider: 'tmdb', value: 'TV 42' },
    { id: 42, kind: 'movie', provider: 'tmdb', value: 'Movie 42' }
  ]
  let multi = replaceResults(createPickerState({ screen: 'bulkMapping' }), 1, mixed)
  t.is(pane(multi).results.items.length, 2)
  multi = reducePicker(multi, { type: 'selection.toggle' })
  multi = reducePicker(multi, { type: 'selection.move', delta: 1 })
  multi = reducePicker(multi, { type: 'selection.toggle' })
  multi = reducePicker(multi, { type: 'step.confirm' })
  t.alike((multi.choices.bulkMapping || []).map((candidate) => candidate.kind), ['tv', 'movie'])

  let state = replaceResults(createPickerState(), 1, mixed)
  state = reducePicker(state, { type: 'step.confirm' })
  state = choose(state, [{ id: 1, value: 'Season 1' }], 0, 2)
  state = reducePicker(state, { type: 'step.back' })
  state = reducePicker(state, { type: 'step.back' })

  state = replaceResults(state, 3, [
    { ...mixed[0], value: 'TV 42 refreshed' },
    mixed[1]
  ])
  state = reducePicker(state, { type: 'step.confirm' })
  t.is(state.screen, 'tvSeason')
  t.is(pane(state).results.status, 'ready')
  t.is(state.choices.tvSeason.id, 1)

  state = reducePicker(state, { type: 'step.back' })
  state = reducePicker(state, { type: 'selection.move', delta: 1 })
  state = reducePicker(state, { type: 'step.confirm' })
  t.is(state.screen, 'movieSource')
  t.is(state.screens.tvSeason, undefined)
  t.is(state.screens.episodeSelection, undefined)
  t.is(state.choices.tvSeason, undefined)
})

test('movie path is search to movieSource to review with reversible steps', (t) => {
  let state = createPickerState({ query: 'arrival' })
  state = choose(state, [{ id: 'movie-329865', kind: 'movie', value: 'Arrival' }])
  t.is(state.screen, 'movieSource')
  state = choose(state, [{ id: 'arrival-file', path: '/media/Arrival.mkv' }])
  t.is(state.screen, 'review')
  t.is(state.choices.movieSource.path, '/media/Arrival.mkv')

  state = reducePicker(state, { type: 'step.back' })
  t.is(state.screen, 'movieSource')
  state = reducePicker(state, { type: 'step.back' })
  t.is(state.screen, 'search')
  t.is(pane(state).input.value, 'arrival')
})

test('creator path includes explicit content and attachment screens before source review', (t) => {
  let state = createPickerState({ query: 'creator' })
  state = choose(state, [{ id: 'creator-1', kind: 'creator', value: 'Creator One' }])
  t.is(state.screen, 'creatorContent')
  state = choose(state, [{ id: 'post-9', value: 'Post 9' }])
  t.is(state.screen, 'creatorAttachment')
  state = choose(state, [{ id: 'attachment-video', value: '1080p video' }])
  t.is(state.screen, 'sourceSelection')
  state = choose(state, [{ id: 'creator-file', path: '/media/creator-9.mp4' }])
  t.is(state.screen, 'review')

  t.alike({
    creator: state.choices.search.id,
    content: state.choices.creatorContent.id,
    attachment: state.choices.creatorAttachment.id,
    source: state.choices.sourceSelection.id
  }, {
    creator: 'creator-1',
    content: 'post-9',
    attachment: 'attachment-video',
    source: 'creator-file'
  })

  state = reducePicker(state, { type: 'step.back' })
  t.is(state.screen, 'sourceSelection')
  state = reducePicker(state, { type: 'step.back' })
  t.is(state.screen, 'creatorAttachment')
  t.is(state.choices.creatorAttachment.id, 'attachment-video')
})

test('bulk path preserves stable mapping selection through review, progress, and result', (t) => {
  let state = createPickerState({ screen: 'bulkMapping', field: 'mapping' })
  state = replaceResults(state, 1, [
    { id: 'map-a', value: 'A' },
    { id: 'map-b', value: 'B' },
    { id: 'map-c', value: 'C' }
  ])
  state = reducePicker(state, { type: 'selection.toggle' })
  state = reducePicker(state, { type: 'selection.move', delta: 2 })
  state = reducePicker(state, { type: 'selection.toggle' })
  const selectedMappings = pane(state).selection.selected
  state = reducePicker(state, { type: 'step.confirm' })
  t.is(state.screen, 'review')
  t.alike(state.choices.bulkMapping.map((mapping) => mapping.id), ['map-a', 'map-c'])

  state = reducePicker(state, { type: 'step.back' })
  t.is(state.screen, 'bulkMapping')
  t.alike(pane(state).selection.selected, selectedMappings)
  state = reducePicker(state, { type: 'step.confirm' })
  state = reducePicker(state, { type: 'step.confirm' })
  t.is(state.screen, 'progress')

  const progress = {
    phase: 'published',
    checkpoint: { jobId: 'bulk-1', completed: ['map-a', 'map-c'] },
    localBytes: { retained: true, paths: ['/media/a', '/media/c'] }
  }
  state = reducePicker(state, { type: 'progress.update', progress })
  state = reducePicker(state, { type: 'progress.complete', value: { imported: 2 } })
  t.is(state.screen, 'result')
  t.alike(state.result, { status: 'completed', value: { imported: 2 }, progress })
})

test('Esc before a durable job produces a normal cancelled result', (t) => {
  const state = createPickerState({ query: 'cancel me' })
  const cancelled = reducePicker(state, { type: 'interrupt' })

  t.is(cancelled.screen, 'result')
  t.alike(cancelled.result, { status: 'cancelled', progress: null })
  t.is(state.screen, 'search')
})

test('malformed progress updates cannot erase a guarded durable checkpoint', (t) => {
  const progress = {
    phase: 'projecting',
    checkpoint: { jobId: 'guarded-job', cursor: 7 },
    localBytes: { retained: true, path: '/media/guarded.mp4' }
  }
  const state = createPickerState({ screen: 'progress', progress })
  const stateBytes = JSON.stringify(state)

  for (const malformed of [
    [],
    null,
    {},
    { phase: 'unknown' },
    { phase: 'projecting' },
    { phase: 'projecting', checkpoint: {}, localBytes: null },
    { phase: 'projecting', checkpoint: {}, localBytes: {} }
  ]) {
    const next = reducePicker(state, { type: 'progress.update', progress: malformed })
    t.is(next, state)
    t.is(JSON.stringify(next), stateBytes)
  }

  const confirming = reducePicker(state, { type: 'interrupt' })
  t.is(confirming.screen, 'exitConfirm')
  t.alike(confirming.exitConfirm.resume.progress, progress)
})

for (const phase of ['replicationPending', 'projecting', 'announcing']) {
  test(`interrupt during ${phase} requires confirmation and preserves exact resumable data`, (t) => {
    const checkpoint = {
      jobId: `job-${phase}`,
      phase,
      requiredRanges: [{ start: 0, end: 42 }]
    }
    const localBytes = {
      retained: true,
      path: `/media/${phase}.mp4`,
      length: 42
    }
    const progress = { phase, checkpoint, localBytes, completed: 3, total: 5 }
    const state = createPickerState({ screen: 'progress', progress })
    const stateBytes = JSON.stringify(state)

    const confirming = reducePicker(state, { type: 'interrupt' })
    t.is(confirming.screen, 'exitConfirm')
    t.alike(confirming.exitConfirm.resume.progress, progress)
    t.is(JSON.stringify(state), stateBytes)

    const repeated = reducePicker(confirming, { type: 'interrupt' })
    t.is(repeated, confirming)

    const resumed = reducePicker(confirming, { type: 'exit.dismiss' })
    t.is(resumed, state)
    t.is(JSON.stringify(resumed), stateBytes)

    const confirmedAgain = reducePicker(resumed, { type: 'interrupt' })
    const exited = reducePicker(confirmedAgain, { type: 'exit.confirm' })
    t.is(exited.screen, 'result')
    t.alike(exited.result, {
      status: 'exited',
      checkpoint,
      localBytes,
      progress
    })
    t.is(JSON.stringify(exited.result.checkpoint), JSON.stringify(checkpoint))
    t.is(JSON.stringify(exited.result.localBytes), JSON.stringify(localBytes))

    let backState = createPickerState({ screen: 'review' })
    backState = reducePicker(backState, { type: 'step.confirm' })
    backState = reducePicker(backState, { type: 'progress.update', progress })
    const backStateBytes = JSON.stringify(backState)

    const backConfirming = reducePicker(backState, { type: 'step.back' })
    t.is(backConfirming.screen, 'exitConfirm')
    t.alike(backConfirming.exitConfirm.resume.progress, progress)
    const backResumed = reducePicker(backConfirming, { type: 'exit.dismiss' })
    t.is(backResumed, backState)
    t.is(JSON.stringify(backResumed), backStateBytes)

    const backConfirmedAgain = reducePicker(backResumed, { type: 'step.back' })
    const backExited = reducePicker(backConfirmedAgain, { type: 'exit.confirm' })
    t.is(backExited.screen, 'result')
    t.alike(backExited.result, {
      status: 'exited',
      checkpoint,
      localBytes,
      progress
    })
    t.is(JSON.stringify(backExited.result.checkpoint), JSON.stringify(checkpoint))
    t.is(JSON.stringify(backExited.result.localBytes), JSON.stringify(localBytes))
  })
}

test('actions and candidate inputs are not mutated or retained as mutable state aliases', (t) => {
  const items = [{ id: 'one', value: 'One', metadata: { nested: ['original'] } }]
  const action = { type: 'results.replace', requestId: 1, items }
  const actionBytes = JSON.stringify(action)
  let state = reducePicker(createPickerState(), { type: 'results.request', requestId: 1 })
  state = reducePicker(state, action)

  t.is(JSON.stringify(action), actionBytes)
  items[0].metadata.nested[0] = 'changed outside'
  t.is(pane(state).results.items[0].metadata.nested[0], 'original')
  t.is(JSON.stringify(JSON.parse(JSON.stringify(state))), JSON.stringify(state))
})

test('cyclic action payloads are rejected without changing serializable state or input', (t) => {
  const cyclic = { label: 'cycle' }
  cyclic.self = cyclic

  const loading = reducePicker(createPickerState(), { type: 'results.request', requestId: 1 })
  const resultActions = [
    {
      type: 'results.replace',
      requestId: 1,
      items: [{ id: 'cyclic-candidate', metadata: cyclic }]
    },
    { type: 'results.error', requestId: 1, error: cyclic }
  ]
  for (const action of resultActions) {
    t.is(reducePicker(loading, action), loading)
    t.is(cyclic.self, cyclic)
    t.ok(JSON.stringify(loading))
  }

  const progress = {
    phase: 'projecting',
    checkpoint: { jobId: 'cycle-job' },
    localBytes: { retained: true }
  }
  const cyclicProgress = { ...progress }
  cyclicProgress.self = cyclicProgress
  const progressing = createPickerState({ screen: 'progress', progress })
  for (const action of [
    { type: 'progress.update', progress: cyclicProgress },
    { type: 'progress.complete', value: cyclic }
  ]) {
    t.is(reducePicker(progressing, action), progressing)
    t.is(cyclic.self, cyclic)
    t.is(cyclicProgress.self, cyclicProgress)
    t.ok(JSON.stringify(progressing))
  }
})

test('cloning preserves prototype-like keys as own data without inherited routing', (t) => {
  const candidate = JSON.parse(
    '{\"id\":\"safe\",\"value\":\"Safe\",\"__proto__\":{\"kind\":\"movie\"},' +
    '\"constructor\":{\"kind\":\"movie\"},\"prototype\":{\"kind\":\"movie\"},' +
    '\"metadata\":{\"__proto__\":{\"polluted\":true},\"constructor\":\"c\",\"prototype\":\"p\"}}'
  )
  let state = replaceResults(createPickerState(), 1, [candidate])
  const stored = pane(state).results.items[0]

  t.is(Object.getPrototypeOf(stored), Object.prototype)
  t.is(Object.prototype.hasOwnProperty.call(stored, '__proto__'), true)
  t.is(stored.kind, undefined)
  t.is(JSON.stringify(stored), JSON.stringify(candidate))
  t.is(reducePicker(state, { type: 'step.confirm' }), state)

  const roundTripped = JSON.parse(JSON.stringify(state))
  t.is(reducePicker(roundTripped, { type: 'step.confirm' }), roundTripped)

  const progress = JSON.parse(
    '{\"phase\":\"projecting\",' +
    '\"checkpoint\":{\"jobId\":\"safe\",\"__proto__\":{\"polluted\":true},' +
    '\"constructor\":\"c\",\"prototype\":\"p\"},' +
    '\"localBytes\":{\"retained\":true,\"__proto__\":{\"polluted\":true},' +
    '\"constructor\":\"c\",\"prototype\":\"p\"}}'
  )
  state = createPickerState({ screen: 'progress', progress })
  t.is(JSON.stringify(state.progress), JSON.stringify(progress))
  t.is(Object.getPrototypeOf(state.progress.checkpoint), Object.prototype)
  t.is(Object.prototype.hasOwnProperty.call(state.progress.checkpoint, '__proto__'), true)
  t.is(state.progress.checkpoint.polluted, undefined)
  t.is(reducePicker(state, { type: 'interrupt' }).screen, 'exitConfirm')
  t.is(JSON.stringify(JSON.parse(JSON.stringify(state))), JSON.stringify(state))
})

test('known actions are exact no-ops after the terminal result screen', (t) => {
  const result = reducePicker(createPickerState(), { type: 'interrupt' })
  const actions = [
    { type: 'query.insert', text: 'ignored' },
    { type: 'query.deleteBackward' },
    { type: 'query.deleteForward' },
    { type: 'query.cursor', delta: 1 },
    { type: 'query.home' },
    { type: 'query.end' },
    { type: 'results.request', requestId: 99 },
    { type: 'results.replace', requestId: 99, items: [] },
    { type: 'results.error', requestId: 99, error: 'ignored' },
    { type: 'results.retry', requestId: 99 },
    { type: 'selection.move', delta: 1 },
    { type: 'selection.toggle' },
    { type: 'selection.complete' },
    { type: 'step.confirm' },
    { type: 'step.back' },
    { type: 'progress.update', progress: { phase: 'ignored' } },
    { type: 'progress.complete', value: 'ignored' },
    { type: 'exit.dismiss' },
    { type: 'exit.confirm' }
  ]

  for (const action of actions) t.is(reducePicker(result, action), result)
})
