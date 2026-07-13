import b4a from 'b4a'

import {
  CELL_CLASS,
  CELL_SIZE,
  DIRECTION,
  MAX_CELL_PAYLOAD,
  CellCodec,
  DatagramReplayWindow,
  PrivateRouteError,
  SenderCounter,
  cryptoSuite
} from '../index.js'
import { TEST_ONLY_CELL_ALLOCATOR } from '../lib/cell-codec.js'
import { createXorshift32 } from '../test/helpers.js'

const DEFAULT_SEED = 1
const DEFAULT_ITERATIONS = 10_000
const MAX_ITERATIONS = 1_000_000
const MAX_CELL_SCRATCH_BYTES = 4096
const KEY = b4a.alloc(32, 0xa1)
const NONCE_PREFIX = b4a.alloc(16, 0xa2)
const CIRCUIT_ID = b4a.alloc(16, 0xa3)
const DESCRIPTOR_ID = b4a.alloc(32, 0xa4)
const FIXTURE_SECRET = 'private-cell-fuzz-fixture-secret'

function parseInteger(name, value, maximum) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be an integer`)
  const parsed = Number(value)
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < (name === 'iterations' ? 1 : 0) ||
    parsed > maximum
  ) {
    throw new Error(`${name} is out of range`)
  }
  return parsed
}

function parseArgs(argv) {
  let seed = DEFAULT_SEED
  let iterations = DEFAULT_ITERATIONS
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--seed' || argument === '--iterations') {
      if (index + 1 >= argv.length) throw new Error(`${argument} requires a value`)
      const value = argv[++index]
      if (argument === '--seed') seed = parseInteger('seed', value, 0xffff_ffff)
      else iterations = parseInteger('iterations', value, MAX_ITERATIONS)
      continue
    }
    if (argument.startsWith('--seed=')) {
      seed = parseInteger('seed', argument.slice(7), 0xffff_ffff)
      continue
    }
    if (argument.startsWith('--iterations=')) {
      iterations = parseInteger('iterations', argument.slice(13), MAX_ITERATIONS)
      continue
    }
    throw new Error(`unknown argument ${argument}`)
  }
  return { seed, iterations }
}

class CountingScratchAllocator {
  constructor() {
    this.current = 0
    this.highWater = 0
    this.allocations = new Map()
  }

  allocate(size) {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('allocator received invalid size')
    const value = b4a.allocUnsafeSlow(size)
    if (this.allocations.has(value)) throw new Error('allocator returned a live buffer twice')
    this.allocations.set(value, size)
    this.current += size
    if (this.current > this.highWater) this.highWater = this.current
    return value
  }

  release(value) {
    const size = this.allocations.get(value)
    if (size === undefined) throw new Error('allocator released unknown scratch bytes')
    this.allocations.delete(value)
    this.current -= size
    if (this.current < 0) throw new Error('allocator current became negative')
  }

  operation(operation) {
    try {
      return operation()
    } finally {
      this.assertClean()
    }
  }

  assertClean() {
    if (this.current !== 0 || this.allocations.size !== 0) {
      throw new Error('allocator retained codec scratch bytes after cleanup')
    }
    if (this.highWater > MAX_CELL_SCRATCH_BYTES)
      throw new Error('allocator high-water limit exceeded')
  }
}

function errorText(error) {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unreadable exception'
  }
}

function assertRedacted(error) {
  const text = errorText(error)
  const descriptorHex = b4a.toString(DESCRIPTOR_ID, 'hex')
  const secretHex = b4a.toString(KEY, 'hex')
  const hasLongHex = /(?:^|[^0-9a-f])[0-9a-f]{32,}(?:$|[^0-9a-f])/i.test(text)
  const hasIpv4 = /(?:^|[^0-9])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?:$|[^0-9])/.test(text)
  const hasIpv6 = /(?:^|[^0-9a-f])(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]{0,39}(?:$|[^0-9a-f:])/i.test(text)
  if (
    hasLongHex ||
    hasIpv4 ||
    hasIpv6 ||
    text.includes(descriptorHex) ||
    text.includes(secretHex) ||
    text.includes(FIXTURE_SECRET)
  ) {
    throw new Error('error text disclosed fixture material or an address')
  }
}

function expectCode(operation, expected) {
  let error = null
  try {
    operation()
  } catch (err) {
    error = err
  }
  if (error !== null) assertRedacted(error)
  if (!(error instanceof PrivateRouteError) || error.code !== expected) {
    throw new Error(`unexpected outcome expected=${expected} actual=${error && error.code}`)
  }
}

function same(actual, expected, outcome) {
  if (!b4a.equals(actual, expected)) throw new Error(`altered plaintext accepted for ${outcome}`)
}

function codec(allocator) {
  return new CellCodec({
    crypto: cryptoSuite,
    cellSize: CELL_SIZE,
    padding: (size) => b4a.alloc(size),
    [TEST_ONLY_CELL_ALLOCATOR]: allocator
  })
}

function seal(cell, allocator, senderCounter, payload) {
  return allocator.operation(() =>
    cell.seal({
      key: KEY,
      noncePrefix: NONCE_PREFIX,
      senderCounter,
      class: CELL_CLASS.DATAGRAM,
      direction: DIRECTION.FORWARD,
      epoch: 1n,
      circuitId: CIRCUIT_ID,
      payload
    })
  )
}

function open(cell, allocator, receiver, packet) {
  return allocator.operation(() =>
    cell.open(
      {
        key: KEY,
        noncePrefix: NONCE_PREFIX,
        receiver,
        expectedClass: CELL_CLASS.DATAGRAM,
        expectedDirection: DIRECTION.FORWARD,
        expectedEpoch: 1n,
        expectedCircuitId: CIRCUIT_ID
      },
      packet
    )
  )
}

function runCase(rng, allocator, iteration) {
  const length = iteration % 31 === 0 ? MAX_CELL_PAYLOAD : rng.integer(MAX_CELL_PAYLOAD + 1)
  const payload = rng.bytes(length)
  const cell = codec(allocator)
  const sender = new SenderCounter()
  const packet = seal(cell, allocator, sender, payload)
  const receiver = new DatagramReplayWindow({ window: 128 })

  same(open(cell, allocator, receiver, packet), payload, 'unchanged')
  expectCode(() => open(cell, allocator, receiver, packet), 'REPLAY')

  const mutated = b4a.from(packet)
  mutated[rng.integer(mutated.byteLength)] ^= 1 << rng.integer(8)
  expectCode(
    () => open(cell, allocator, new DatagramReplayWindow({ window: 128 }), mutated),
    'CELL_INVALID'
  )

  const truncated = packet.subarray(0, rng.integer(CELL_SIZE))
  expectCode(
    () => open(cell, allocator, new DatagramReplayWindow({ window: 128 }), truncated),
    'CELL_INVALID'
  )

  const extended = b4a.alloc(CELL_SIZE + 1 + rng.integer(32))
  extended.set(packet)
  expectCode(
    () => open(cell, allocator, new DatagramReplayWindow({ window: 128 }), extended),
    'CELL_INVALID'
  )

  const nextPayload = rng.bytes(rng.integer(MAX_CELL_PAYLOAD + 1))
  const nextPacket = seal(cell, allocator, sender, nextPayload)
  same(open(cell, allocator, receiver, nextPacket), nextPayload, 'valid-next-counter')
  allocator.assertClean()
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const rng = createXorshift32(options.seed)
  const allocator = new CountingScratchAllocator()
  let unexpected = 0

  for (let iteration = 0; iteration < options.iterations; iteration++) {
    try {
      runCase(rng, allocator, iteration)
    } catch (error) {
      unexpected++
      assertRedacted(error)
      throw new Error(
        `seed=${options.seed} iteration=${iteration} unexpected=${unexpected} ${errorText(error)}`
      )
    }
  }

  allocator.assertClean()
  console.log(
    `seed=${options.seed} iterations=${options.iterations} unexpected=${unexpected} highWater<=${MAX_CELL_SCRATCH_BYTES}`
  )
}

try {
  main()
} catch (error) {
  console.error(errorText(error))
  process.exitCode = 1
}
