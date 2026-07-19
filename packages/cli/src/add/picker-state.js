const MULTI_SELECT_SCREENS = new Set(['episodeSelection', 'bulkMapping'])
const GUARDED_PUBLICATION_PHASES = new Set([
  'replicationPending',
  'projecting',
  'announcing'
])
const RECOGNIZED_PROGRESS_PHASES = new Set([
  'pending',
  'resolving',
  'downloading',
  'uploading',
  'uploaded',
  'replicationPending',
  'durabilityVerified',
  'projecting',
  'projected',
  'announcing',
  'announced',
  'finalizing',
  'published',
  'failed',
  'skipped'
])
const INVALID_DATA = Symbol('invalid-data')
const CHOICE_DEPENDENCIES = {
  search: {
    screens: [
      'tvSeason',
      'episodeSelection',
      'movieSource',
      'creatorContent',
      'creatorAttachment',
      'sourceSelection',
      'review',
      'progress'
    ],
    choices: [
      'tvSeason',
      'episodes',
      'movieSource',
      'creatorContent',
      'creatorAttachment',
      'sourceSelection'
    ]
  },
  tvSeason: {
    screens: ['episodeSelection', 'sourceSelection', 'review', 'progress'],
    choices: ['episodes', 'sourceSelection']
  },
  episodes: {
    screens: ['sourceSelection', 'review', 'progress'],
    choices: ['sourceSelection']
  },
  movieSource: {
    screens: ['review', 'progress'],
    choices: []
  },
  creatorContent: {
    screens: ['creatorAttachment', 'sourceSelection', 'review', 'progress'],
    choices: ['creatorAttachment', 'sourceSelection']
  },
  creatorAttachment: {
    screens: ['sourceSelection', 'review', 'progress'],
    choices: ['sourceSelection']
  },
  sourceSelection: {
    screens: ['review', 'progress'],
    choices: []
  },
  bulkMapping: {
    screens: ['review', 'progress'],
    choices: []
  }
}
const PANE_ACTIONS = new Set([
  'query.insert',
  'query.deleteBackward',
  'query.deleteForward',
  'query.cursor',
  'query.home',
  'query.end',
  'results.request',
  'results.retry',
  'results.replace',
  'results.error',
  'selection.move',
  'selection.toggle',
  'selection.complete',
  'step.confirm'
])


const SCREEN_FIELDS = {
  search: 'query',
  tvSeason: 'season',
  episodeSelection: 'episode',
  sourceSelection: 'source',
  movieSource: 'source',
  creatorContent: 'content',
  creatorAttachment: 'attachment',
  bulkMapping: 'mapping',
  review: 'review',
  progress: 'progress'
}

export function createPickerState (options = {}) {
  const screen = typeof options.screen === 'string' ? options.screen : 'search'
  const value = typeof options.query === 'string' ? options.query : ''
  const field = typeof options.field === 'string'
    ? options.field
    : (SCREEN_FIELDS[screen] || 'query')

  const progress = options.progress == null ? null : cloneData(options.progress)
  return {
    screen,
    screens: {
      [screen]: createPane(field, value)
    },
    history: [],
    choices: {},
    latestRequestId: validInitialRequestId(options.latestRequestId),
    progress: progress === INVALID_DATA || !isProgressRecord(progress) ? null : progress,
    result: null,
    exitConfirm: null
  }
}

export function reducePicker (state, action) {
  if (!state || typeof state !== 'object' || !action || typeof action !== 'object') return state
  if (PANE_ACTIONS.has(action.type) && (!state.screens || !state.screens[state.screen])) return state

  switch (action.type) {
    case 'query.insert':
      return insertQuery(state, action.text)
    case 'query.deleteBackward':
      return deleteQuery(state, -1)
    case 'query.deleteForward':
      return deleteQuery(state, 1)
    case 'query.cursor':
      return moveQueryCursor(state, action.delta)
    case 'query.home':
      return setQueryCursor(state, 0)
    case 'query.end':
      return setQueryCursor(state, currentPane(state).input.value.length)
    case 'results.request':
    case 'results.retry':
      return startRequest(state, action.requestId)
    case 'results.replace':
      return replaceResults(state, action)
    case 'results.error':
      return failResults(state, action)
    case 'selection.move':
      return moveSelection(state, action.delta)
    case 'selection.toggle':
      return toggleSelection(state)
    case 'selection.complete':
      return completeSelection(state)
    case 'step.confirm':
      return confirmStep(state)
    case 'step.back':
      return backStep(state)
    case 'progress.update':
      return updateProgress(state, action)
    case 'progress.complete':
      return completeProgress(state, action.value)
    case 'interrupt':
      return interrupt(state)
    case 'exit.dismiss':
      return dismissExit(state)
    case 'exit.confirm':
      return confirmExit(state)
    default:
      return state
  }
}

function createPane (field, value = '') {
  return {
    input: { field, value, cursor: value.length },
    results: { status: 'idle', requestId: null, items: [], error: null },
    selection: { index: 0, selected: [] }
  }
}

function currentPane (state) {
  return state.screens[state.screen]
}

function withPane (state, pane) {
  if (pane === currentPane(state)) return state
  return {
    ...state,
    screens: {
      ...state.screens,
      [state.screen]: pane
    }
  }
}

function withInput (state, input) {
  const pane = currentPane(state)
  return withPane(state, { ...pane, input })
}

function insertQuery (state, text) {
  if (typeof text !== 'string' || text.length === 0) return state
  const input = currentPane(state).input
  const value = input.value.slice(0, input.cursor) + text + input.value.slice(input.cursor)
  return withInput(state, { ...input, value, cursor: input.cursor + text.length })
}

function deleteQuery (state, direction) {
  const input = currentPane(state).input
  if (direction < 0) {
    if (input.cursor === 0) return state
    const value = input.value.slice(0, input.cursor - 1) + input.value.slice(input.cursor)
    return withInput(state, { ...input, value, cursor: input.cursor - 1 })
  }

  if (input.cursor >= input.value.length) return state
  const value = input.value.slice(0, input.cursor) + input.value.slice(input.cursor + 1)
  return withInput(state, { ...input, value })
}

function moveQueryCursor (state, delta) {
  if (!Number.isFinite(delta)) return state
  const input = currentPane(state).input
  return setQueryCursor(state, input.cursor + Math.trunc(delta))
}

function setQueryCursor (state, cursor) {
  const input = currentPane(state).input
  const nextCursor = Math.max(0, Math.min(input.value.length, cursor))
  if (nextCursor === input.cursor) return state
  return withInput(state, { ...input, cursor: nextCursor })
}

function startRequest (state, requestId) {
  if (!isNewRequestId(state, requestId)) return state
  const pane = currentPane(state)
  return {
    ...state,
    screens: {
      ...state.screens,
      [state.screen]: {
        ...pane,
        results: {
          ...pane.results,
          status: 'loading',
          requestId,
          error: null
        }
      }
    },
    latestRequestId: requestId
  }
}

function replaceResults (state, action) {
  if (!isCurrentResponse(state, action.requestId) || !Array.isArray(action.items)) return state
  const pane = currentPane(state)
  const clonedItems = cloneData(action.items)
  if (clonedItems === INVALID_DATA) return state
  const items = deduplicateCandidates(clonedItems.filter(isCandidate))
  const index = items.length === 0
    ? 0
    : Math.min(pane.selection.index, items.length - 1)
  const available = new Set(items.map(candidateIdentity))
  const selected = pane.selection.selected.filter((key) => available.has(key))

  return withPane(state, {
    ...pane,
    results: {
      status: 'ready',
      requestId: action.requestId,
      items,
      error: null
    },
    selection: { index, selected }
  })
}

function failResults (state, action) {
  if (!isCurrentResponse(state, action.requestId)) return state
  const error = cloneData(action.error)
  if (error === INVALID_DATA) return state
  const pane = currentPane(state)
  return withPane(state, {
    ...pane,
    results: {
      ...pane.results,
      status: 'error',
      error
    }
  })
}

function moveSelection (state, delta) {
  if (!Number.isFinite(delta)) return state
  const pane = currentPane(state)
  const length = pane.results.items.length
  if (length === 0) return state
  const step = Math.trunc(delta)
  if (step === 0) return state

  // Picker boundaries wrap in both directions; modulo also handles large deltas.
  const index = ((pane.selection.index + step) % length + length) % length
  if (index === pane.selection.index) return state
  return withPane(state, {
    ...pane,
    selection: { ...pane.selection, index }
  })
}

function toggleSelection (state) {
  if (!MULTI_SELECT_SCREENS.has(state.screen)) return state
  const pane = currentPane(state)
  const candidate = pane.results.items[pane.selection.index]
  if (!candidate) return state
  const key = candidateIdentity(candidate, pane.selection.index)
  const selected = pane.selection.selected.includes(key)
    ? pane.selection.selected.filter((value) => value !== key)
    : [...pane.selection.selected, key]

  return withPane(state, {
    ...pane,
    selection: { ...pane.selection, selected }
  })
}

function completeSelection (state) {
  const pane = currentPane(state)
  const candidate = pane.results.items[pane.selection.index]
  if (!candidate) return state
  const value = completionValue(candidate)
  if (value == null) return state
  return withInput(state, {
    ...pane.input,
    value,
    cursor: value.length
  })
}

function confirmStep (state) {
  const pane = currentPane(state)
  const candidate = pane && pane.results.items[pane.selection.index]

  switch (state.screen) {
    case 'search': {
      if (!candidate) return state
      const kind = candidate.kind || candidate.type
      const next = kind === 'tv'
        ? 'tvSeason'
        : kind === 'movie'
          ? 'movieSource'
          : kind === 'creator'
            ? 'creatorContent'
            : null
      if (!next) return state
      return forwardChoice(state, next, 'search', candidate)
    }
    case 'tvSeason':
      return candidate
        ? forwardChoice(state, 'episodeSelection', 'tvSeason', candidate)
        : state
    case 'episodeSelection': {
      const episodes = selectedCandidates(pane)
      return episodes.length > 0
        ? forwardChoice(state, 'sourceSelection', 'episodes', episodes)
        : state
    }
    case 'movieSource':
      return candidate
        ? forwardChoice(state, 'review', 'movieSource', candidate)
        : state
    case 'creatorContent':
      return candidate
        ? forwardChoice(state, 'creatorAttachment', 'creatorContent', candidate)
        : state
    case 'creatorAttachment':
      return candidate
        ? forwardChoice(state, 'sourceSelection', 'creatorAttachment', candidate)
        : state
    case 'sourceSelection':
      return candidate
        ? forwardChoice(state, 'review', 'sourceSelection', candidate)
        : state
    case 'bulkMapping': {
      const mappings = selectedCandidates(pane)
      return mappings.length > 0
        ? forwardChoice(state, 'review', 'bulkMapping', mappings)
        : state
    }
    case 'review': {
      const progress = state.progress || {
        phase: 'pending',
        checkpoint: null,
        localBytes: null
      }
      return forward(state, 'progress', null, { progress })
    }
    default:
      return state
  }
}

function selectedCandidates (pane) {
  const selected = new Set(pane.selection.selected)
  return cloneData(pane.results.items.filter((candidate, index) => {
    return selected.has(candidateIdentity(candidate, index))
  }))
}

function forwardChoice (state, screen, choice, value) {
  const previous = state.choices[choice]
  const base = previous !== undefined && !sameChoice(previous, value)
    ? clearDependencies(state, CHOICE_DEPENDENCIES[choice])
    : state
  return forward(base, screen, { [choice]: cloneData(value) })
}

function sameChoice (left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((candidate, index) => {
      return candidateIdentity(candidate) === candidateIdentity(right[index])
    })
  }
  return candidateIdentity(left) === candidateIdentity(right)
}

function clearDependencies (state, dependencies) {
  if (!dependencies) return state
  const screens = { ...state.screens }
  const choices = { ...state.choices }
  for (const screen of dependencies.screens) delete screens[screen]
  for (const choice of dependencies.choices) delete choices[choice]
  const clearsProgress = dependencies.screens.includes('progress')
  return {
    ...state,
    screens,
    choices,
    progress: clearsProgress ? null : state.progress,
    result: clearsProgress ? null : state.result,
    exitConfirm: null
  }
}

function forward (state, screen, choices = null, updates = null) {
  const screens = state.screens[screen]
    ? state.screens
    : {
        ...state.screens,
        [screen]: createPane(SCREEN_FIELDS[screen] || 'query')
      }

  return {
    ...state,
    ...(updates || {}),
    screen,
    screens,
    history: [...state.history, state.screen],
    choices: choices ? { ...state.choices, ...choices } : state.choices,
    exitConfirm: null
  }
}

function backStep (state) {
  if (state.screen === 'result') return state
  if (state.screen === 'exitConfirm') return dismissExit(state)
  if (state.screen === 'progress') return interrupt(state)
  if (state.history.length === 0) return cancelledResult(state)
  const screen = state.history[state.history.length - 1]
  return {
    ...state,
    screen,
    history: state.history.slice(0, -1),
    exitConfirm: null
  }
}

function updateProgress (state, action) {
  if (state.screen !== 'progress') return state
  const progress = cloneData(action.progress)
  if (progress === INVALID_DATA || !isProgressRecord(progress)) return state
  return { ...state, progress }
}

function completeProgress (state, value) {
  if (state.screen !== 'progress') return state
  const resultValue = cloneData(value)
  if (resultValue === INVALID_DATA) return state
  return {
    ...state,
    screen: 'result',
    result: {
      status: 'completed',
      value: resultValue,
      progress: state.progress
    },
    exitConfirm: null
  }
}

function interrupt (state) {
  if (state.screen === 'exitConfirm' || state.screen === 'result') return state
  if (state.screen === 'progress' && GUARDED_PUBLICATION_PHASES.has(state.progress && state.progress.phase)) {
    return {
      ...state,
      screen: 'exitConfirm',
      exitConfirm: { resume: state }
    }
  }
  return cancelledResult(state)
}

function dismissExit (state) {
  if (state.screen !== 'exitConfirm' || !state.exitConfirm) return state
  return state.exitConfirm.resume
}

function confirmExit (state) {
  if (state.screen !== 'exitConfirm' || !state.exitConfirm) return state
  const resume = state.exitConfirm.resume
  const progress = resume.progress
  return {
    ...resume,
    screen: 'result',
    result: {
      status: 'exited',
      checkpoint: progress && progress.checkpoint,
      localBytes: progress && progress.localBytes,
      progress
    },
    exitConfirm: null
  }
}

function cancelledResult (state) {
  return {
    ...state,
    screen: 'result',
    result: { status: 'cancelled', progress: state.progress },
    exitConfirm: null
  }
}

function isNewRequestId (state, requestId) {
  return Number.isSafeInteger(requestId) && requestId > state.latestRequestId
}

function isCurrentResponse (state, requestId) {
  const pane = currentPane(state)
  return Number.isSafeInteger(requestId) &&
    pane.results.status === 'loading' &&
    requestId === state.latestRequestId &&
    requestId === pane.results.requestId
}

function validInitialRequestId (requestId) {
  return Number.isSafeInteger(requestId) && requestId >= 0 ? requestId : 0
}

function isProgressRecord (progress) {
  if (progress == null || typeof progress !== 'object' || Array.isArray(progress)) return false
  if (!RECOGNIZED_PROGRESS_PHASES.has(progress.phase)) return false
  if (!GUARDED_PUBLICATION_PHASES.has(progress.phase)) return true
  return isNonEmptyRecord(progress.checkpoint) && isNonEmptyRecord(progress.localBytes)
}

function isNonEmptyRecord (value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length > 0
}

function isCandidate (candidate) {
  if (candidate == null || typeof candidate !== 'object' || Array.isArray(candidate)) return false
  return candidate.id != null ||
    candidate.key != null ||
    candidate.completion != null ||
    candidate.value != null ||
    candidate.path != null ||
    candidate.label != null
}

function candidateIdentity (candidate, index = 0) {
  const key = candidate.id ?? candidate.key ?? candidate.value ?? candidate.path ??
    candidate.label ?? candidate.completion ?? index
  return JSON.stringify({
    kind: candidate.kind ?? null,
    type: candidate.type ?? null,
    provider: candidate.provider ?? null,
    source: candidate.source ?? null,
    keyType: typeof key,
    key
  })
}

function deduplicateCandidates (candidates) {
  const seen = new Set()
  return candidates.filter((candidate, index) => {
    const identity = candidateIdentity(candidate, index)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

function completionValue (candidate) {
  const value = candidate.completion ?? candidate.value ?? candidate.path ?? candidate.label
  if (value == null) return null
  return typeof value === 'string' ? value : String(value)
}

function cloneData (value, ancestors = new Set()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return null
  if (ancestors.has(value)) return INVALID_DATA

  ancestors.add(value)
  if (Array.isArray(value)) {
    const clone = new Array(value.length)
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        clone[index] = null
        continue
      }
      const clonedEntry = cloneData(descriptor.value, ancestors)
      if (clonedEntry === INVALID_DATA) {
        ancestors.delete(value)
        return INVALID_DATA
      }
      clone[index] = clonedEntry
    }
    ancestors.delete(value)
    return clone
  }

  const clone = {}
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue
    const entry = descriptor.value
    if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue
    const clonedEntry = cloneData(entry, ancestors)
    if (clonedEntry === INVALID_DATA) {
      ancestors.delete(value)
      return INVALID_DATA
    }
    Object.defineProperty(clone, key, {
      value: clonedEntry,
      enumerable: true,
      writable: true,
      configurable: true
    })
  }
  ancestors.delete(value)
  return clone
}
