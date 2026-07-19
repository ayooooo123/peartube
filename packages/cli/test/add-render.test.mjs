import test from 'brittle'
import {
  displayWidth,
  renderPicker,
  renderPickerLines,
  stripAnsi,
  truncateDisplay
} from '../src/add/render.js'
import { createPickerState, reducePicker } from '../src/add/picker-state.js'

const terminal = { columns: 100, rows: 30, color: true }
const plain = lines => lines.map(stripAnsi)

function withResults ({ screen, field, query = '', items, index = 0, selected = [] }) {
  let state = createPickerState({ screen, field, query })
  state = reducePicker(state, { type: 'results.request', requestId: 1 })
  state = reducePicker(state, { type: 'results.replace', requestId: 1, items })
  for (const selectedIndex of selected) {
    const current = state.screens[screen].selection.index
    state = reducePicker(state, { type: 'selection.move', delta: selectedIndex - current })
    state = reducePicker(state, { type: 'selection.toggle' })
  }
  const current = state.screens[screen].selection.index
  if (current !== index) state = reducePicker(state, { type: 'selection.move', delta: index - current })
  return state
}

function assertFrame (t, state, expected, options = terminal) {
  const lines = renderPickerLines(state, options)
  t.alike(plain(lines), expected)
  t.is(renderPicker(state, options), lines.join('\n'))
  t.ok(lines.length <= options.rows)
  for (const line of lines) {
    t.ok(displayWidth(line) <= options.columns, `${stripAnsi(line)} fits ${options.columns} columns`)
  }
  const footers = plain(lines).filter(line => line.startsWith('peartube add ·'))
  t.is(footers.length, 1, 'exactly one footer')
  t.is(plain(lines).at(-1), footers[0], 'footer is the last line')
}

test('search renderer snapshot has a stable header, query, result badges, hints, and footer', (t) => {
  const state = withResults({
    screen: 'search',
    field: 'query',
    query: 'matrix',
    items: [
      { id: 'movie-603', kind: 'movie', label: 'The Matrix', year: 1999 },
      { id: 'tv-1920', kind: 'tv', label: 'The Matrix', year: 1993 }
    ]
  })

  assertFrame(t, state, [
    'PearTube Add',
    'Find content',
    'Search: matrix',
    '',
    '› [MOVIE] The Matrix (1999)',
    '  [TV] The Matrix (1993)',
    '',
    '↑/↓ Move  Tab Complete  Enter Select  Esc Back',
    'peartube add · interactive'
  ])
})

test('season and episode multi-select renderer snapshots preserve selection context', (t) => {
  const seasons = withResults({
    screen: 'tvSeason',
    field: 'season',
    query: '',
    items: [
      { id: 's1', label: 'Season 1', episodeCount: 7 },
      { id: 's2', label: 'Season 2', episodeCount: 13 }
    ],
    index: 1
  })
  assertFrame(t, seasons, [
    'PearTube Add',
    'Choose a season',
    'Season: ',
    '',
    '  Season 1 · 7 episodes',
    '› Season 2 · 13 episodes',
    '',
    '↑/↓ Move  Tab Complete  Enter Select  Esc Back',
    'peartube add · interactive'
  ])

  const episodes = withResults({
    screen: 'episodeSelection',
    field: 'episode',
    query: 'season 1',
    items: [
      { id: 'e1', seasonNumber: 1, episodeNumber: 1, title: 'Pilot' },
      { id: 'e2', seasonNumber: 1, episodeNumber: 2, title: "Cat's in the Bag..." }
    ],
    selected: [0],
    index: 1
  })
  assertFrame(t, episodes, [
    'PearTube Add',
    'Choose episodes',
    'Episode: season 1',
    '',
    '  [x] S01E01 · Pilot',
    '› [ ] S01E02 · Cat\'s in the Bag...',
    '',
    '↑/↓ Move  Tab Complete  Enter Continue  Esc Back',
    'peartube add · interactive'
  ])
})

test('creator attachment renderer snapshot identifies platform and availability', (t) => {
  const state = withResults({
    screen: 'creatorAttachment',
    field: 'attachment',
    query: '@maker',
    items: [
      { id: 'youtube:@maker', platform: 'youtube', label: '@maker', status: 'available' },
      { id: 'rumble:maker', platform: 'rumble', label: 'Maker Channel', status: 'URL required' }
    ]
  })

  assertFrame(t, state, [
    'PearTube Add',
    'Attach creator source',
    'Attachment: @maker',
    '',
    '› [YOUTUBE] @maker · available',
    '  [RUMBLE] Maker Channel · URL required',
    '',
    '↑/↓ Move  Tab Complete  Enter Select  Esc Back',
    'peartube add · interactive'
  ])
})

test('bulk mapping renderer snapshot is a compact source-to-target table', (t) => {
  const state = withResults({
    screen: 'bulkMapping',
    field: 'mapping',
    items: [
      { id: 'm1', source: 'pilot.mkv', target: 'S01E01 · Pilot', confidence: 'exact' },
      { id: 'm2', source: 'second episode.mkv', target: 'S01E02 · Cat\'s in the Bag...', confidence: 'review' }
    ],
    selected: [0],
    index: 1
  })

  assertFrame(t, state, [
    'PearTube Add',
    'Verify source mapping',
    'Mapping: ',
    '',
    '  Source │ Target',
    '  [x] pilot.mkv │ S01E01 · Pilot · exact',
    '› [ ] second episode.mkv │ S01E02 · Cat\'s in the Bag... · review',
    '',
    '↑/↓ Move  Tab Complete  Enter Continue  Esc Back',
    'peartube add · interactive'
  ])
})

test('progress renderer redraw snapshot remains a stable frame rather than an appended log', (t) => {
  const initial = createPickerState({
    screen: 'progress',
    progress: {
      phase: 'replicationPending',
      checkpoint: { jobId: 'job-7' },
      localBytes: { path: '/tmp/pilot.mkv' },
      title: 'Pilot',
      completed: 2,
      total: 5,
      message: 'Waiting for trusted relay'
    }
  })
  const updated = reducePicker(initial, {
    type: 'progress.update',
    progress: {
      phase: 'replicationPending',
      checkpoint: { jobId: 'job-7' },
      localBytes: { path: '/tmp/pilot.mkv' },
      title: 'Pilot',
      completed: 3,
      total: 5,
      message: 'Verifying durable ranges'
    }
  })

  assertFrame(t, initial, [
    'PearTube Add',
    'Publishing',
    '',
    'Phase: Replication pending',
    'Item: Pilot',
    'Progress: 2/5 [████████░░░░░░░░░░░░] 40%',
    'Waiting for trusted relay',
    '',
    'Ctrl-C Exit safely',
    'peartube add · interactive'
  ])
  const updatedLines = plain(renderPickerLines(updated, terminal))
  t.is(updatedLines.length, 10)
  t.ok(updatedLines.includes('Progress: 3/5 [████████████░░░░░░░░] 60%'))
  t.ok(updatedLines.includes('Verifying durable ranges'))
  t.absent(updatedLines.includes('Waiting for trusted relay'))
})

test('publishing exit confirmation snapshot explains durable behavior', (t) => {
  const progress = {
    phase: 'projecting',
    checkpoint: { jobId: 'job-7' },
    localBytes: { path: '/tmp/pilot.mkv' }
  }
  const publishing = createPickerState({ screen: 'progress', progress })
  const state = reducePicker(publishing, { type: 'interrupt' })

  assertFrame(t, state, [
    'PearTube Add',
    'Publication in progress',
    '',
    'Publishing is past the durable checkpoint.',
    'Exit without rolling back published work?',
    'Checkpoint: job-7',
    '',
    'Enter Exit safely  Esc Keep waiting',
    'peartube add · interactive'
  ])
})

test('completed result and error renderer snapshots are deterministic', (t) => {
  const completed = {
    ...createPickerState(),
    screen: 'result',
    result: {
      status: 'completed',
      value: { title: 'The Matrix', message: 'Published The Matrix' },
      progress: { phase: 'published' }
    }
  }
  assertFrame(t, completed, [
    'PearTube Add',
    'Result',
    '',
    'Completed',
    'Published The Matrix',
    '',
    'Enter Close',
    'peartube add · interactive'
  ])

  const failed = {
    ...createPickerState(),
    screen: 'result',
    result: {
      status: 'error',
      error: { message: 'Disk is full' }
    }
  }
  assertFrame(t, failed, [
    'PearTube Add',
    'Result',
    '',
    'Error',
    'Disk is full',
    '',
    'Enter Close',
    'peartube add · interactive'
  ])
})

test('narrow terminals truncate safely by display width and keep one bounded footer', (t) => {
  const state = withResults({
    screen: 'search',
    field: 'query',
    query: 'extraordinarily long query',
    items: [
      { id: 'long', kind: 'movie', label: 'A very long 界界界 title', year: 2026 },
      { id: 'other', kind: 'tv', label: 'Other result', year: 2025 }
    ]
  })
  const options = { columns: 24, rows: 8, color: false }

  assertFrame(t, state, [
    'PearTube Add',
    'Find content',
    'Search: extraordinaril…',
    '',
    '› [MOVIE] A very long …',
    '',
    '↑/↓ Move  Tab Complete…',
    'peartube add · interac…'
  ], options)
  t.is(truncateDisplay('界界界', 5), '界界…')
  t.is(displayWidth(truncateDisplay('e\u0301界abcdef', 6)), 6)
  t.absent(truncateDisplay('e\u0301界abcdef', 6).endsWith('\u0301'))
})

test('result window is bounded by rows and follows the highlighted item', (t) => {
  const items = Array.from({ length: 20 }, (_, index) => ({
    id: `item-${index}`,
    label: `Result ${String(index).padStart(2, '0')}`
  }))
  const state = withResults({
    screen: 'search',
    field: 'query',
    query: 'result',
    items,
    index: 15
  })
  const options = { columns: 40, rows: 9, color: false }
  const lines = renderPickerLines(state, options)

  t.is(lines.length, 9)
  t.ok(lines.some(line => line.includes('› Result 15')))
  t.absent(lines.some(line => line.includes('Result 00')))
  t.is(lines.at(-1), 'peartube add · interactive')
  for (const line of lines) t.ok(displayWidth(line) <= 40)
})

test('no-color rendering contains no ANSI while color mode styles without changing snapshots', (t) => {
  const state = withResults({
    screen: 'search',
    field: 'query',
    query: 'matrix',
    items: [{ id: 'movie-603', kind: 'movie', label: 'The Matrix', year: 1999 }]
  })
  const noColor = renderPickerLines(state, { columns: 100, rows: 30, color: false })
  const color = renderPickerLines(state, terminal)

  t.absent(noColor.some(line => line.includes('\u001b[')))
  t.ok(color.some(line => line.includes('\u001b[')))
  t.alike(color.map(stripAnsi), noColor)
  t.is(stripAnsi('\u001b[31mred\u001b[0m'), 'red')
})
