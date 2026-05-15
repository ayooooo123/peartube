import crypto from 'node:crypto'
import {
  EventType,
  DescriptorState,
  ProofKind,
  V1AvailabilityProof,
  DescriptorAddedPayload,
  ProofAddedPayload,
  encodeProof,
  toFixed32,
  toFixed64,
  toBuffer,
} from './schemas.js'
import { appendProofAdded } from './autobase.js'

const textEncoder = new TextEncoder()
const ZERO_32 = new Uint8Array(32)
const ZERO_64 = new Uint8Array(64)

function keyHex(bytes) {
  return Buffer.from(bytes || ZERO_32).toString('hex')
}

async function sha256Bytes(input) {
  const data = input instanceof Uint8Array ? input : textEncoder.encode(String(input ?? ''))
  if (globalThis.crypto?.subtle?.digest) {
    return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data))
  }
  return new Uint8Array(crypto.createHash('sha256').update(Buffer.from(data)).digest())
}

function stableSerialize(value) {
  if (value === null || value === undefined) return String(value)
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex')
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableSerialize(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function ensureBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.floor(value)))
  return fallback
}

function clampPositive(n, fallback) {
  const value = Number(n)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function getCoreLength(core) {
  if (!core) return 0
  if (typeof core.length === 'number') return core.length
  if (typeof core.blocks === 'number') return core.blocks
  if (typeof core.byteLength === 'number') return Math.max(1, Math.ceil(core.byteLength / 65536))
  return 0
}

async function readBlock(core, index) {
  if (!core) return null
  if (typeof core.get === 'function') return core.get(index)
  if (typeof core.read === 'function') return core.read(index)
  if (typeof core.checkout === 'function') {
    const view = core.checkout(getCoreLength(core))
    return view?.get ? view.get(index) : null
  }
  return null
}

function makeEvidence(samples) {
  return toBuffer(stableSerialize(samples))
}

export async function sampleCoreAvailability(core, descriptor, options = {}) {
  if (!core) {
    return {
      reachable: false,
      sampleCount: 0,
      sampleWindowMs: clampPositive(options.sampleWindowMs, 10 * 60 * 1000),
      activePeers: 0,
      servedBytes: 0n,
      latencyMs: 0,
      chainHead: ZERO_32,
      evidence: makeEvidence({ error: 'missing-core' }),
    }
  }

  const requestedSampleCount = clampPositive(options.sampleCount, 4)
  const sampleWindowMs = clampPositive(options.sampleWindowMs, 10 * 60 * 1000)
  const length = getCoreLength(core)
  const maxIndex = Math.max(0, length - 1)
  const descriptorId = descriptor?.descriptorId || ZERO_32
  const contentRoot = descriptor?.contentRoot || ZERO_32
  const dasRoot = descriptor?.dasRoot || ZERO_32
  const seeds = []
  const start = Date.now()

  for (let i = 0; i < requestedSampleCount; i++) {
    const seed = await sha256Bytes(Buffer.concat([
      Buffer.from(descriptorId),
      Buffer.from(contentRoot),
      Buffer.from(dasRoot),
      Buffer.from(String(i)),
    ]))
    const view = new DataView(seed.buffer, seed.byteOffset, seed.byteLength)
    const offset = view.getUint32(0, false) / 0xffffffff
    seeds.push(Math.min(maxIndex, Math.floor(offset * (maxIndex + 1))))
  }

  const samples = []
  let servedBytes = 0n
  let reachable = length > 0

  for (const index of seeds) {
    try {
      const block = await readBlock(core, index)
      if (block == null) {
        reachable = false
        samples.push({ index, ok: false })
        continue
      }
      const bytes = block instanceof Uint8Array ? block : toBuffer(block)
      servedBytes += BigInt(bytes.byteLength || 0)
      samples.push({ index, ok: true, bytes: bytes.byteLength || 0, hash: Buffer.from(await sha256Bytes(bytes)).toString('hex') })
    } catch (error) {
      reachable = false
      samples.push({ index, ok: false, error: error?.message || String(error) })
    }
  }

  const latencyMs = Math.max(0, Date.now() - start)
  const chainHead = await sha256Bytes(Buffer.concat([
    Buffer.from(descriptorId),
    Buffer.from(contentRoot),
    Buffer.from(dasRoot),
    Buffer.from(String(length)),
    Buffer.from(String(servedBytes)),
  ]))

  return {
    reachable,
    sampleCount: samples.length,
    sampleWindowMs,
    activePeers: clampPositive(core?.peers?.length || core?.writablePeers?.length || 0, 0),
    servedBytes,
    latencyMs,
    chainHead,
    evidence: makeEvidence({ samples, length, descriptorId: keyHex(descriptorId) }),
  }
}

export async function buildAvailabilityProof(descriptor, core, options = {}) {
  const now = ensureBigInt(options.now, BigInt(Date.now()))
  const sampleCount = clampPositive(options.sampleCount, 4)
  const sampleWindowMs = clampPositive(options.sampleWindowMs, 10 * 60 * 1000)
  const relayId = toFixed32(options.relayId || options.signer || ZERO_32)
  const signer = toFixed32(options.signer || relayId)
  const sampled = await sampleCoreAvailability(core, descriptor, { sampleCount, sampleWindowMs })

  const proof = {
    version: 1,
    proofId: ZERO_32,
    descriptorId: toFixed32(descriptor?.descriptorId || ZERO_32),
    contentRoot: toFixed32(descriptor?.contentRoot || ZERO_32),
    dasRoot: toFixed32(descriptor?.dasRoot || ZERO_32),
    relayId,
    reachable: Boolean(sampled.reachable),
    proofKind: options.proofKind ?? ProofKind.SAMPLE,
    sampleCount: sampled.sampleCount,
    sampleWindowMs,
    observedAt: now,
    expiresAt: ensureBigInt(options.expiresAt, now + BigInt(sampleWindowMs)),
    servedBytes: ensureBigInt(sampled.servedBytes, 0n),
    latencyMs: clampPositive(sampled.latencyMs, 0),
    activePeers: clampPositive(sampled.activePeers, 0),
    chainHead: toFixed32(sampled.chainHead || ZERO_32),
    evidence: toBuffer(sampled.evidence),
    signer,
    signature: ZERO_64,
  }

  const unsigned = encodeProof(proof)
  const signBytes = options.signBytes || options.sign
  if (typeof signBytes !== 'function') {
    throw new Error('buildAvailabilityProof requires signBytes(payload)')
  }

  const signature = await signBytes(unsigned)
  proof.signature = toFixed64(signature)
  proof.proofId = await sha256Bytes(Buffer.concat([
    Buffer.from(proof.descriptorId),
    Buffer.from(proof.relayId),
    Buffer.from(String(proof.observedAt)),
    Buffer.from(proof.signature),
  ]))
  const signedPayload = encodeProof({ ...proof, signature: ZERO_64 })

  return {
    proof,
    unsigned: signedPayload,
    sampled,
    signature: proof.signature,
  }
}

function eventPayloadForProof(proof, sampled, options = {}) {
  return {
    proof,
    localSeenAt: ensureBigInt(options.localSeenAt, proof.observedAt),
    confidence: Math.max(1, Math.min(255, options.confidence ?? (proof.reachable ? 3 : 1))),
    stateAfterProof: proof.reachable ? DescriptorState.ACTIVE : DescriptorState.QUARANTINED,
    failureCountReset: Boolean(proof.reachable),
  }
}

export async function emitAvailabilityProof(autobase, descriptor, core, options = {}) {
  const generated = await buildAvailabilityProof(descriptor, core, options)
  const payload = eventPayloadForProof(generated.proof, generated.sampled, options)

  if (autobase) {
    await appendProofAdded(autobase, payload, {
      signer: generated.proof.signer,
      actorId: options.actorId || generated.proof.relayId,
      prevEntryId: options.prevEntryId,
      observedAt: generated.proof.observedAt,
      signBytes: options.signBytes,
    })
  }

  return {
    ...generated,
    payload,
  }
}

export function createProofEmitter(options = {}) {
  const timers = new Set()
  let stopped = false

  const stop = () => {
    stopped = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  const schedule = (fn, delayMs) => {
    if (stopped) return null
    const timer = setTimeout(async () => {
      timers.delete(timer)
      if (stopped) return
      try { await fn() } catch { /* best effort cleanup */ }
    }, Math.max(0, delayMs))
    timers.add(timer)
    return timer
  }

  const tick = async ({ autobase, descriptor, core, intervalMs = options.intervalMs || 10 * 60 * 1000, ...rest } = {}) => {
    if (stopped) return null
    const emitted = await emitAvailabilityProof(autobase, descriptor, core, { ...options, ...rest })
    if (autobase && typeof intervalMs === 'number' && intervalMs > 0 && !stopped) {
      schedule(() => tick({ autobase, descriptor, core, intervalMs, ...rest }), intervalMs)
    }
    return emitted
  }

  return {
    tick,
    stop,
    schedule,
  }
}

export default {
  sampleCoreAvailability,
  buildAvailabilityProof,
  emitAvailabilityProof,
  createProofEmitter,
}
