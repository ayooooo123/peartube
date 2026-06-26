// Engine benchmark harness — dependency-free so it runs identically under
// node (V8), `bare` with libjs (V8), `bare` with libquickjs (QuickJS), and
// `bare` with libjerry (JerryScript). No native addons, no npm deps: this
// measures *pure JS engine* behaviour on PearTube's real hot paths, which is
// exactly what changes when BARE_ENGINE is swapped to shrink libbare-kit.so.

const hasPerf = typeof globalThis.performance?.now === 'function'
const now = hasPerf ? () => globalThis.performance.now() : () => Date.now()

// Identify whatever engine we happen to be running under. Bare does not expose
// a single canonical field across engines, so we probe a few and always allow
// an explicit override via --label / BENCH_LABEL.
export function detectEngine(labelOverride) {
  const g = globalThis
  const info = { label: labelOverride || '', runtime: 'unknown', engine: 'unknown', versions: {} }

  if (typeof g.Bare !== 'undefined') {
    info.runtime = 'bare'
    const v = g.Bare?.versions || g.Bare?.version || {}
    info.versions = typeof v === 'object' ? v : { bare: String(v) }
    if (info.versions.v8) info.engine = `v8 ${info.versions.v8}`
    else if (info.versions.quickjs) info.engine = `quickjs ${info.versions.quickjs}`
    else if (info.versions.jerryscript || info.versions.jerry) info.engine = `jerryscript ${info.versions.jerryscript || info.versions.jerry}`
  } else if (typeof process !== 'undefined' && process.versions?.node) {
    info.runtime = 'node'
    info.versions = { node: process.versions.node, v8: process.versions.v8 }
    info.engine = `v8 ${process.versions.v8}`
  }

  // Heuristic fallbacks when the runtime doesn't self-report an engine.
  if (info.engine === 'unknown') {
    if (typeof g.Atomics === 'undefined') info.engine = 'jerryscript?' // Jerry lacks SAB/Atomics
    else if (typeof g.WebAssembly === 'undefined') info.engine = 'quickjs?' // QuickJS-ng ships no wasm
  }
  if (!info.label) info.label = info.engine
  return info
}

// Deterministic PRNG (mulberry32) so every engine processes byte-identical
// inputs — required for the cross-engine output checksums to be meaningful.
export function makeRng(seed) {
  let a = seed >>> 0
  return function rng() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// FNV-1a over a string — used to checksum each workload's output so two engines
// can be proven to have computed the *same* result, not just at the same speed.
export function checksum(value) {
  const s = typeof value === 'string' ? value : stableStringify(value)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

// Run one workload: warm up, then time `iterations` batches and report
// throughput + latency distribution. `fn` returns a value we checksum once.
export function runWorkload({ name, setup, fn, iterations = 60, warmup = 10 }) {
  const ctx = setup ? setup() : undefined
  let out
  for (let i = 0; i < warmup; i++) out = fn(ctx)

  const samples = new Array(iterations)
  const startAll = now()
  for (let i = 0; i < iterations; i++) {
    const t0 = now()
    out = fn(ctx)
    samples[i] = now() - t0
  }
  const wallMs = now() - startAll

  samples.sort((a, b) => a - b)
  const sum = samples.reduce((acc, v) => acc + v, 0)
  const meanMs = sum / samples.length
  return {
    name,
    iterations,
    meanMs: round(meanMs),
    p50Ms: round(percentile(samples, 50)),
    p99Ms: round(percentile(samples, 99)),
    minMs: round(samples[0]),
    opsPerSec: meanMs > 0 ? Math.round(1000 / meanMs) : null,
    wallMs: round(wallMs),
    out: checksum(out),
  }
}

function round(n) {
  return Math.round(n * 1000) / 1000
}
