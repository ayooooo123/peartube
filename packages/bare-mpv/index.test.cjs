const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const packageDir = __dirname
const bindingPath = path.join(packageDir, 'binding.js')
const indexPath = path.join(packageDir, 'index.js')

function loadWithFakeBinding(fakeBinding) {
  delete require.cache[indexPath]
  require.cache[bindingPath] = {
    id: bindingPath,
    filename: bindingPath,
    loaded: true,
    exports: fakeBinding,
  }

  const loaded = require(indexPath)

  delete require.cache[indexPath]
  delete require.cache[bindingPath]
  return loaded
}

test('MpvPlayer pumps pending mpv events before reading state and frames', () => {
  let processEventsCalls = 0
  let renderUpdateCalls = 0
  let getPropertyCalls = 0
  let renderFrameCalls = 0

  const fakeBinding = {
    create: () => ({ handle: true }),
    initialize: () => 0,
    command: () => 0,
    setProperty: () => 0,
    getProperty: () => {
      getPropertyCalls += 1
      return 12.5
    },
    renderCreate: () => ({ render: true }),
    renderUpdate: () => {
      renderUpdateCalls += 1
      return true
    },
    renderFrame: () => {
      renderFrameCalls += 1
      return new Uint8Array([0, 1, 2, 3])
    },
    renderFree: () => {},
    destroy: () => {},
    processEvents: () => {
      processEventsCalls += 1
      return 1
    },
  }

  const { MpvPlayer } = loadWithFakeBinding(fakeBinding)
  const player = new MpvPlayer()

  player.initialize()
  player.initRender(640, 360)

  assert.equal(player.currentTime, 12.5)
  assert.equal(player.duration, 12.5)
  assert.equal(player.paused, false)
  assert.equal(player.needsRender(), true)
  assert.deepEqual(Array.from(player.renderFrame()), [0, 1, 2, 3])

  assert.equal(getPropertyCalls >= 3, true)
  assert.equal(renderUpdateCalls, 1)
  assert.equal(renderFrameCalls, 1)
  assert.equal(
    processEventsCalls >= 5,
    true,
    `expected processEvents to be called before state/frame reads, got ${processEventsCalls}`
  )
})

test('MpvPlayer pumps events after playback commands', () => {
  let processEventsCalls = 0
  const commands = []

  const fakeBinding = {
    create: () => ({ handle: true }),
    initialize: () => 0,
    command: (_handle, args) => {
      commands.push(args.join(' '))
      return 0
    },
    setProperty: (_handle, name, value) => {
      commands.push(`${name}:${value}`)
      return 0
    },
    getProperty: () => undefined,
    renderCreate: () => ({ render: true }),
    renderUpdate: () => false,
    renderFrame: () => null,
    renderFree: () => {},
    destroy: () => {},
    processEvents: () => {
      processEventsCalls += 1
      return 1
    },
  }

  const { MpvPlayer } = loadWithFakeBinding(fakeBinding)
  const player = new MpvPlayer()

  player.loadFile('https://example.com/video.mp4')
  player.play()
  player.pause()
  player.seek(42)

  assert.deepEqual(commands, [
    'loadfile https://example.com/video.mp4',
    'pause:false',
    'pause:true',
    'seek 42 absolute',
  ])
  assert.equal(
    processEventsCalls >= 4,
    true,
    `expected processEvents after playback commands, got ${processEventsCalls}`
  )
})
