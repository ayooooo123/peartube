import test from 'brittle'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import path from 'node:path'
import {
  TerminalUsageError,
  mapKeypressToAction,
  runTerminal
} from '../src/add/terminal.js'
import {
  PathUsageError,
  completePath,
  confirmPath,
  createPickerController,
  listPathCandidates
} from '../src/add/controller.js'
import { createPickerState } from '../src/add/picker-state.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

class FakeInput extends PassThrough {
  constructor (isTTY = true) {
    super()
    this.isTTY = isTTY
    this.rawModes = []
  }

  setRawMode (enabled) {
    this.rawModes.push(enabled)
    return this
  }
}

class FakeOutput {
  constructor (isTTY = true, columns = 100, rows = 30) {
    this.isTTY = isTTY
    this.columns = columns
    this.rows = rows
    this.chunks = []
  }

  write (chunk) {
    this.chunks.push(String(chunk))
    return true
  }

  read () {
    return this.chunks.join('')
  }
}

class FakeClock {
  constructor () {
    this.now = 0
    this.nextId = 1
    this.tasks = new Map()
  }

  setTimeout = (fn, delay) => {
    const id = this.nextId++
    this.tasks.set(id, { at: this.now + delay, fn })
    return id
  }

  clearTimeout = (id) => {
    this.tasks.delete(id)
  }

  tick (milliseconds) {
    this.now += milliseconds
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.now)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (!due) return
      this.tasks.delete(due[0])
      due[1].fn()
    }
  }
}

function deferred () {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function occurrences (value, needle) {
  return value.split(needle).length - 1
}

function assertTerminalRestored (t, input, output, signals, before) {
  const bytes = output.read()
  t.alike(input.rawModes, [true, false])
  t.is(occurrences(bytes, '\u001b[?25l'), 1, 'cursor is hidden once')
  t.is(occurrences(bytes, '\u001b[?25h'), 1, 'cursor is shown once')
  t.is(input.listenerCount('keypress'), before.keypress)
  t.is(input.listenerCount('data'), before.data)
  t.is(signals.listenerCount('SIGINT'), before.sigint)
}

function terminalHarness () {
  const input = new FakeInput()
  const output = new FakeOutput()
  const signals = new EventEmitter()
  const before = {
    keypress: input.listenerCount('keypress'),
    data: input.listenerCount('data'),
    sigint: signals.listenerCount('SIGINT')
  }
  return { input, output, signals, before }
}

test('raw keypresses normalize to picker reducer actions without forwarding control bytes', (t) => {
  t.alike(mapKeypressToAction('text', { name: 't', sequence: 'text' }), {
    type: 'query.insert',
    text: 'text'
  })
  t.alike(mapKeypressToAction(undefined, { name: 'up', sequence: '\u001b[A' }), {
    type: 'selection.move',
    delta: -1
  })
  t.alike(mapKeypressToAction(undefined, { name: 'down', sequence: '\u001b[B' }), {
    type: 'selection.move',
    delta: 1
  })
  t.alike(mapKeypressToAction('\t', { name: 'tab', sequence: '\t' }), { type: 'selection.complete' })
  t.alike(mapKeypressToAction('\r', { name: 'return', sequence: '\r' }), { type: 'step.confirm' })
  t.alike(mapKeypressToAction('\u001b', { name: 'escape', sequence: '\u001b' }), { type: 'step.back' })
  t.alike(mapKeypressToAction('\u0003', { name: 'c', ctrl: true, sequence: '\u0003' }), { type: 'interrupt' })
  t.alike(mapKeypressToAction(undefined, { name: 'backspace' }), { type: 'query.deleteBackward' })
  t.alike(mapKeypressToAction(undefined, { name: 'delete' }), { type: 'query.deleteForward' })
  t.alike(mapKeypressToAction(undefined, { name: 'left' }), { type: 'query.cursor', delta: -1 })
  t.alike(mapKeypressToAction(undefined, { name: 'right' }), { type: 'query.cursor', delta: 1 })
  t.alike(mapKeypressToAction(undefined, { name: 'home' }), { type: 'query.home' })
  t.alike(mapKeypressToAction(undefined, { name: 'end' }), { type: 'query.end' })
  t.is(mapKeypressToAction('\u001b[A', {}), null, 'an escape sequence is never query text')
  t.alike(mapKeypressToAction('safe\u0000\u0007\ntext', {}), {
    type: 'query.insert',
    text: 'safetext'
  })
  t.is(mapKeypressToAction('\u0000\u001f\u007f', {}), null)
})

test('readline handles split escape sequences, multibyte text, and paste without query leakage', async (t) => {
  const harness = terminalHarness()
  const actions = []
  const states = []
  const done = runTerminal({
    ...harness,
    initialState: createPickerState(),
    onAction: action => actions.push(action),
    onState: state => states.push(state)
  })

  harness.input.write(Buffer.from('café '))
  harness.input.write(Buffer.from('\u001b['))
  harness.input.write(Buffer.from('B'))
  harness.input.write(Buffer.from('\t'))
  harness.input.write(Buffer.from('\r'))
  harness.input.write(Buffer.from('\u001b'))

  const state = await done
  t.is(state.result.status, 'cancelled')
  t.is(state.screens.search.input.value, 'café ')
  t.absent(state.screens.search.input.value.includes('[B'))
  t.ok(actions.some(action => action.type === 'selection.move' && action.delta === 1))
  t.ok(actions.some(action => action.type === 'selection.complete'))
  t.ok(actions.some(action => action.type === 'step.confirm'))
  t.ok(actions.some(action => action.type === 'step.back'))
  t.ok(states.length >= 2)
  assertTerminalRestored(t, harness.input, harness.output, harness.signals, harness.before)
})

test('redraw erases and replaces the prior frame instead of scrolling progress lines', async (t) => {
  const harness = terminalHarness()
  const done = runTerminal({
    ...harness,
    initialState: createPickerState(),
    render: state => ['Header', `Query: ${state.screens.search.input.value}`, 'Footer']
  })

  harness.input.write('abc')
  harness.input.write('\u0003')
  await done

  const frames = harness.output.chunks.filter(chunk => chunk.includes('Header'))
  t.ok(frames.length >= 4)
  for (const frame of frames.slice(1)) {
    t.ok(frame.startsWith('\r\u001b[2A\u001b[J'), 'subsequent frame moves over and erases three prior lines')
  }
  t.is(occurrences(harness.output.read(), '\u001b[J'), frames.length)
  assertTerminalRestored(t, harness.input, harness.output, harness.signals, harness.before)
})

test('terminal cleanup is balanced after an already-complete successful state', async (t) => {
  const harness = terminalHarness()
  const initialState = {
    ...createPickerState(),
    screen: 'result',
    result: { status: 'completed', value: { title: 'Done' }, progress: null }
  }

  const result = await runTerminal({ ...harness, initialState })
  t.is(result, initialState)
  assertTerminalRestored(t, harness.input, harness.output, harness.signals, harness.before)
})

test('terminal cleanup is balanced when rendering throws', async (t) => {
  const harness = terminalHarness()
  await t.exception(runTerminal({
    ...harness,
    initialState: createPickerState(),
    render: () => { throw new Error('render exploded') }
  }), /render exploded/)
  assertTerminalRestored(t, harness.input, harness.output, harness.signals, harness.before)
})

test('normal Ctrl-C dispatches interrupt, resolves cancellation, and restores listeners', async (t) => {
  const harness = terminalHarness()
  const actions = []
  const done = runTerminal({
    ...harness,
    initialState: createPickerState(),
    onAction: action => actions.push(action)
  })
  harness.input.write('\u0003')
  const result = await done

  t.is(result.result.status, 'cancelled')
  t.alike(actions, [{ type: 'interrupt' }])
  assertTerminalRestored(t, harness.input, harness.output, harness.signals, harness.before)
})

test('SIGINT follows the reducer interrupt path and restores terminal state', async (t) => {
  const harness = terminalHarness()
  const actions = []
  const done = runTerminal({
    ...harness,
    initialState: createPickerState(),
    onAction: action => actions.push(action)
  })
  harness.signals.emit('SIGINT')
  const result = await done

  t.is(result.result.status, 'cancelled')
  t.alike(actions, [{ type: 'interrupt' }])
  assertTerminalRestored(t, harness.input, harness.output, harness.signals, harness.before)
})

test('Ctrl-C during guarded publication opens exit confirmation without cancel or rollback', async (t) => {
  const harness = terminalHarness()
  const actions = []
  const states = []
  const progress = {
    phase: 'replicationPending',
    checkpoint: { jobId: 'job-7' },
    localBytes: { path: '/tmp/media.mkv' }
  }
  const done = runTerminal({
    ...harness,
    initialState: createPickerState({ screen: 'progress', progress }),
    onAction: action => actions.push(action),
    onState: state => states.push(state)
  })

  harness.input.write('\u0003')
  await tick()
  t.is(states.at(-1).screen, 'exitConfirm')
  t.is(states.at(-1).result, null)
  t.alike(states.at(-1).exitConfirm.resume.progress, progress)
  t.alike(actions, [{ type: 'interrupt' }])

  harness.input.write('\r')
  const result = await done
  t.is(result.screen, 'result')
  t.is(result.result.status, 'exited')
  t.alike(actions, [{ type: 'interrupt' }, { type: 'exit.confirm' }])
  assertTerminalRestored(t, harness.input, harness.output, harness.signals, harness.before)
})

test('non-TTY input or output rejects with an actionable typed usage error', async (t) => {
  for (const [inputTTY, outputTTY] of [[false, true], [true, false]]) {
    let error = null
    try {
      await runTerminal({
        input: new FakeInput(inputTTY),
        output: new FakeOutput(outputTTY),
        signals: new EventEmitter(),
        initialState: createPickerState()
      })
    } catch (cause) {
      error = cause
    }
    t.ok(error instanceof TerminalUsageError)
    t.is(error.code, 'ERR_PEARTUBE_TTY_REQUIRED')
    t.is(error.exitCode, 2)
    t.ok(error.message.includes('--no-input'))
  }
})

test('controller debounces searches, aborts the previous request, and ignores stale settlement', async (t) => {
  const clock = new FakeClock()
  const actions = []
  const first = deferred()
  const second = deferred()
  const calls = []
  const search = (query, context) => {
    calls.push({ query, context })
    return calls.length === 1 ? first.promise : second.promise
  }
  const controller = createPickerController({
    dispatch: action => actions.push(action),
    search,
    clock,
    debounceMs: 25
  })

  t.is(controller.request('first'), 1)
  clock.tick(24)
  t.is(calls.length, 0)
  clock.tick(1)
  t.is(calls.length, 1)
  t.is(calls[0].context.requestId, 1)

  t.is(controller.request('second'), 2)
  t.is(calls[0].context.signal.aborted, true)
  clock.tick(25)
  t.is(calls.length, 2)
  t.is(calls[1].context.requestId, 2)

  second.resolve([{ id: 'current', label: 'Current' }])
  await tick()
  first.resolve([{ id: 'stale', label: 'Stale' }])
  await tick()

  t.alike(actions, [
    { type: 'results.request', requestId: 1 },
    { type: 'results.request', requestId: 2 },
    { type: 'results.replace', requestId: 2, items: [{ id: 'current', label: 'Current' }] }
  ])
  controller.cleanup()
})

test('controller dispatches only active errors and cleanup cancels timers and requests', async (t) => {
  const clock = new FakeClock()
  const actions = []
  const current = deferred()
  let call = null
  const controller = createPickerController({
    dispatch: action => actions.push(action),
    search: (query, context) => {
      call = { query, context }
      return current.promise
    },
    clock,
    debounceMs: 10,
    initialRequestId: 40
  })

  t.is(controller.request('broken'), 41)
  clock.tick(10)
  current.reject(Object.assign(new Error('provider offline'), { code: 'OFFLINE' }))
  await tick()
  t.alike(actions, [
    { type: 'results.request', requestId: 41 },
    { type: 'results.error', requestId: 41, error: { message: 'provider offline', code: 'OFFLINE' } }
  ])

  t.is(controller.request('never runs'), 42)
  controller.cleanup()
  t.is(call.context.signal.aborted, true)
  clock.tick(100)
  t.is(actions.length, 3, 'cleanup prevents a late result or error')
  t.is(controller.request('after cleanup'), null)
})

test('path candidates scan only the active parent and preserve tilde, quotes, and spaces', async (t) => {
  const readdirCalls = []
  const filesystem = {
    async readdir (directory, options) {
      readdirCalls.push([directory, options])
      return [
        dirent('Other', false),
        dirent('My Videos', true),
        dirent('My Video.mp4', false)
      ]
    }
  }
  const options = {
    filesystem,
    path: path.posix,
    homedir: () => '/home/test',
    cwd: '/work'
  }

  const candidates = await listPathCandidates('"~/Media/My V', options)
  t.alike(readdirCalls, [['/home/test/Media', { withFileTypes: true }]])
  t.alike(candidates.map(candidate => ({ name: candidate.name, completion: candidate.completion, directory: candidate.directory })), [
    { name: 'My Video.mp4', completion: '"~/Media/My Video.mp4', directory: false },
    { name: 'My Videos', completion: '"~/Media/My Videos/', directory: true }
  ])
  t.is(completePath('"~/Media/My V', candidates, { index: 1 }), '"~/Media/My Video')
  t.is(completePath('"~/Media/My Video', candidates, { index: 1 }), '"~/Media/My Videos/')
  t.is(readdirCalls.length, 1, 'completion does not recursively scan or stat candidates')
})

test('path completion appends the injected platform separator and preserves closing quotes', async (t) => {
  const filesystem = {
    async readdir () {
      return [dirent('Show Files', true)]
    }
  }
  const candidates = await listPathCandidates('"C:\\Media\\Show F"', {
    filesystem,
    path: path.win32,
    homedir: () => 'C:\\Users\\test',
    cwd: 'C:\\work'
  })

  t.is(candidates[0].completion, '"C:\\Media\\Show Files\\"')
  t.is(completePath('"C:\\Media\\Show F"', candidates), '"C:\\Media\\Show Files\\"')
})

test('final path confirmation normalizes once, checks readability, and reports typed errors', async (t) => {
  const accessCalls = []
  const filesystem = {
    async access (filePath) {
      accessCalls.push(filePath)
      if (filePath.endsWith('missing.mkv')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    }
  }
  const options = {
    filesystem,
    path: path.posix,
    homedir: () => '/home/test',
    cwd: '/work'
  }

  t.is(await confirmPath('"./Media/../movie file.mkv"', options), 'movie file.mkv')
  t.is(await confirmPath('~/Videos/../clip.mkv', options), '/home/test/clip.mkv')
  t.alike(accessCalls, ['/work/movie file.mkv', '/home/test/clip.mkv'])

  let error = null
  try {
    await confirmPath('./missing.mkv', options)
  } catch (cause) {
    error = cause
  }
  t.ok(error instanceof PathUsageError)
  t.is(error.code, 'ERR_PEARTUBE_PATH_UNREADABLE')
  t.is(error.exitCode, 2)
  t.ok(error.message.includes('./missing.mkv'))
  t.is(error.cause.code, 'EACCES')
})

function dirent (name, directory) {
  return {
    name,
    isDirectory: () => directory
  }
}
