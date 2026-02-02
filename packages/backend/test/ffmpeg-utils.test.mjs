import test from 'brittle'
import {
  safeDestroy,
  safeUnref,
  safeBufferCopy,
  safeBoundsCheck,
  safeRangeCheck,
  ResourceTracker,
  copyCodecParameters
} from '../src/transcode/ffmpeg-utils.mjs'

// Mock objects for testing
function createMockDestroyable() {
  return {
    _handle: {},
    destroyed: false,
    destroy() {
      if (this.destroyed) throw new Error('Already destroyed')
      this.destroyed = true
      this._handle = null
    }
  }
}

function createMockUnrefable() {
  return {
    _handle: {},
    unrefed: false,
    unref() {
      if (this.unrefed) throw new Error('Already unrefed')
      this.unrefed = true
    }
  }
}

// safeDestroy tests
test('safeDestroy - destroys valid object', async (t) => {
  const obj = createMockDestroyable()
  safeDestroy(obj)
  t.is(obj.destroyed, true)
})

test('safeDestroy - handles null', async (t) => {
  t.execution(() => safeDestroy(null))
})

test('safeDestroy - handles undefined', async (t) => {
  t.execution(() => safeDestroy(undefined))
})

test('safeDestroy - handles object without destroy method', async (t) => {
  t.execution(() => safeDestroy({ foo: 'bar' }))
})

test('safeDestroy - handles already destroyed object (null handle)', async (t) => {
  const obj = {
    _handle: null,
    destroy() {
      throw new Error('Should not be called')
    }
  }
  t.execution(() => safeDestroy(obj))
})

test('safeDestroy - handles destroy that throws', async (t) => {
  const obj = {
    _handle: {},
    destroy() {
      throw new Error('Destroy failed')
    }
  }
  t.execution(() => safeDestroy(obj))
})

test('safeDestroy - prevents double destroy', async (t) => {
  const obj = createMockDestroyable()
  safeDestroy(obj)
  t.execution(() => safeDestroy(obj)) // Second call should not throw
})

// safeUnref tests
test('safeUnref - unrefs valid object', async (t) => {
  const obj = createMockUnrefable()
  safeUnref(obj)
  t.is(obj.unrefed, true)
})

test('safeUnref - handles null', async (t) => {
  t.execution(() => safeUnref(null))
})

test('safeUnref - handles undefined', async (t) => {
  t.execution(() => safeUnref(undefined))
})

test('safeUnref - handles object without unref method', async (t) => {
  t.execution(() => safeUnref({ foo: 'bar' }))
})

test('safeUnref - handles null handle', async (t) => {
  const obj = {
    _handle: null,
    unref() {
      throw new Error('Should not be called')
    }
  }
  t.execution(() => safeUnref(obj))
})

test('safeUnref - handles unref that throws', async (t) => {
  const obj = {
    _handle: {},
    unref() {
      throw new Error('Unref failed')
    }
  }
  t.execution(() => safeUnref(obj))
})

// safeBufferCopy tests
test('safeBufferCopy - copies buffer content', async (t) => {
  const source = Buffer.from('hello world')
  const copy = safeBufferCopy(source)

  t.alike(copy, source)
  t.not(copy, source) // Different object
})

test('safeBufferCopy - modifications do not affect original', async (t) => {
  const source = Buffer.from('hello')
  const copy = safeBufferCopy(source)

  copy[0] = 0x58 // 'X'

  t.is(source[0], 0x68) // 'h' - unchanged
  t.is(copy[0], 0x58) // 'X' - modified
})

test('safeBufferCopy - handles empty buffer', async (t) => {
  const source = Buffer.alloc(0)
  const copy = safeBufferCopy(source)

  t.is(copy.length, 0)
})

test('safeBufferCopy - handles null', async (t) => {
  const copy = safeBufferCopy(null)
  t.is(copy.length, 0)
})

test('safeBufferCopy - handles undefined', async (t) => {
  const copy = safeBufferCopy(undefined)
  t.is(copy.length, 0)
})

test('safeBufferCopy - handles large buffer', async (t) => {
  const source = Buffer.alloc(1024 * 1024) // 1MB
  for (let i = 0; i < source.length; i++) {
    source[i] = i % 256
  }

  const copy = safeBufferCopy(source)
  t.alike(copy, source)
})

// safeBoundsCheck tests
test('safeBoundsCheck - allows valid index', async (t) => {
  t.is(safeBoundsCheck(0, 10), true)
  t.is(safeBoundsCheck(5, 10), true)
  t.is(safeBoundsCheck(9, 10), true)
})

test('safeBoundsCheck - throws for negative index', async (t) => {
  try {
    safeBoundsCheck(-1, 10)
    t.fail('Should throw')
  } catch (err) {
    t.ok(err instanceof RangeError)
  }
})

test('safeBoundsCheck - throws for index equal to length', async (t) => {
  try {
    safeBoundsCheck(10, 10)
    t.fail('Should throw')
  } catch (err) {
    t.ok(err instanceof RangeError)
  }
})

test('safeBoundsCheck - throws for index greater than length', async (t) => {
  try {
    safeBoundsCheck(15, 10)
    t.fail('Should throw')
  } catch (err) {
    t.ok(err instanceof RangeError)
  }
})

test('safeBoundsCheck - includes context in error', async (t) => {
  try {
    safeBoundsCheck(-1, 10, 'test access')
    t.fail('Should throw')
  } catch (err) {
    t.ok(err.message.includes('test access'))
  }
})

// safeRangeCheck tests
test('safeRangeCheck - allows valid range', async (t) => {
  t.is(safeRangeCheck(0, 10, 10), true)
  t.is(safeRangeCheck(0, 5, 10), true)
  t.is(safeRangeCheck(5, 10, 10), true)
})

test('safeRangeCheck - allows empty range', async (t) => {
  t.is(safeRangeCheck(5, 5, 10), true)
})

test('safeRangeCheck - throws for negative start', async (t) => {
  try {
    safeRangeCheck(-1, 5, 10)
    t.fail('Should throw')
  } catch (err) {
    t.ok(err instanceof RangeError)
  }
})

test('safeRangeCheck - throws for negative end', async (t) => {
  try {
    safeRangeCheck(0, -1, 10)
    t.fail('Should throw')
  } catch (err) {
    t.ok(err instanceof RangeError)
  }
})

test('safeRangeCheck - throws when end less than start', async (t) => {
  try {
    safeRangeCheck(5, 3, 10)
    t.fail('Should throw')
  } catch (err) {
    t.ok(err instanceof RangeError)
  }
})

test('safeRangeCheck - throws when end exceeds length', async (t) => {
  try {
    safeRangeCheck(0, 15, 10)
    t.fail('Should throw')
  } catch (err) {
    t.ok(err instanceof RangeError)
  }
})

test('safeRangeCheck - includes context in error', async (t) => {
  try {
    safeRangeCheck(5, 3, 10, 'slice op')
    t.fail('Should throw')
  } catch (err) {
    t.ok(err.message.includes('slice op'))
  }
})

// ResourceTracker tests
test('ResourceTracker - tracks resources', async (t) => {
  const tracker = new ResourceTracker()
  const obj1 = createMockDestroyable()
  const obj2 = createMockDestroyable()

  tracker.track(obj1, 'first')
  tracker.track(obj2, 'second')

  t.is(tracker.size, 2)
  t.alike(tracker.names, ['first', 'second'])
})

test('ResourceTracker - returns tracked object', async (t) => {
  const tracker = new ResourceTracker()
  const obj = createMockDestroyable()

  const result = tracker.track(obj, 'test')
  t.is(result, obj)
})

test('ResourceTracker - handles null gracefully', async (t) => {
  const tracker = new ResourceTracker()
  const result = tracker.track(null, 'null')

  t.is(result, null)
  t.is(tracker.size, 0)
})

test('ResourceTracker - destroys specific resource', async (t) => {
  const tracker = new ResourceTracker()
  const obj1 = createMockDestroyable()
  const obj2 = createMockDestroyable()

  tracker.track(obj1, 'first')
  tracker.track(obj2, 'second')

  tracker.destroy('first')

  t.is(obj1.destroyed, true)
  t.is(obj2.destroyed, false)
  t.is(tracker.size, 1)
})

test('ResourceTracker - destroyAll in LIFO order', async (t) => {
  const order = []
  const tracker = new ResourceTracker()

  const obj1 = {
    _handle: {},
    destroy() {
      order.push('first')
      this._handle = null
    }
  }
  const obj2 = {
    _handle: {},
    destroy() {
      order.push('second')
      this._handle = null
    }
  }
  const obj3 = {
    _handle: {},
    destroy() {
      order.push('third')
      this._handle = null
    }
  }

  tracker.track(obj1, 'first')
  tracker.track(obj2, 'second')
  tracker.track(obj3, 'third')

  tracker.destroyAll()

  // Should be LIFO (last in, first out)
  t.alike(order, ['third', 'second', 'first'])
  t.is(tracker.size, 0)
})

test('ResourceTracker - auto-generates names', async (t) => {
  const tracker = new ResourceTracker()
  const obj = createMockDestroyable()

  tracker.track(obj) // No name provided

  t.is(tracker.size, 1)
  t.ok(tracker.names[0].startsWith('resource_'))
})

test('ResourceTracker - handles destroy errors gracefully', async (t) => {
  const tracker = new ResourceTracker()
  const badObj = {
    _handle: {},
    destroy() {
      throw new Error('Destroy failed')
    }
  }
  const goodObj = createMockDestroyable()

  tracker.track(badObj, 'bad')
  tracker.track(goodObj, 'good')

  // Should not throw, should continue to next object
  t.execution(() => tracker.destroyAll())
  t.is(goodObj.destroyed, true)
})

// copyCodecParameters tests
test('copyCodecParameters - uses copyFrom if available', async (t) => {
  let copyFromCalled = false
  const src = { width: 1920, height: 1080 }
  const dest = {
    copyFrom(other) {
      copyFromCalled = true
      Object.assign(this, other)
    }
  }

  copyCodecParameters(dest, src)

  t.is(copyFromCalled, true)
  t.is(dest.width, 1920)
})

test('copyCodecParameters - manual copy when copyFrom unavailable', async (t) => {
  const src = {
    id: 27,
    type: 'video',
    width: 1920,
    height: 1080,
    format: 'yuv420p',
    bitRate: 5000000,
    profile: 'high',
    level: 41
  }
  const dest = {}

  copyCodecParameters(dest, src)

  t.is(dest.id, 27)
  t.is(dest.type, 'video')
  t.is(dest.width, 1920)
  t.is(dest.height, 1080)
  t.is(dest.format, 'yuv420p')
  t.is(dest.bitRate, 5000000)
})

test('copyCodecParameters - copies audio properties', async (t) => {
  const src = {
    type: 'audio',
    sampleRate: 48000,
    nbChannels: 2,
    channelLayout: 'stereo'
  }
  const dest = {}

  copyCodecParameters(dest, src)

  t.is(dest.sampleRate, 48000)
  t.is(dest.nbChannels, 2)
  t.is(dest.channelLayout, 'stereo')
})

test('copyCodecParameters - defensive copy of extraData', async (t) => {
  const extraData = Buffer.from([0x00, 0x01, 0x02])
  const src = { extraData }
  const dest = {}

  copyCodecParameters(dest, src)

  t.alike(dest.extraData, extraData)
  t.not(dest.extraData, extraData) // Should be a copy

  // Modify original, dest should be unchanged
  extraData[0] = 0xFF
  t.is(dest.extraData[0], 0x00)
})

test('copyCodecParameters - handles empty extraData', async (t) => {
  const src = { extraData: Buffer.alloc(0) }
  const dest = {}

  copyCodecParameters(dest, src)

  t.absent(dest.extraData)
})

test('copyCodecParameters - handles missing properties', async (t) => {
  const src = { width: 1920 } // Only width
  const dest = {}

  copyCodecParameters(dest, src)

  t.is(dest.width, 1920)
  t.absent(dest.height)
  t.absent(dest.sampleRate)
})
