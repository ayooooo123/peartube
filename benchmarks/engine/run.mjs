/* global Bare */
// Entry point. Run under each engine you want to compare:
//
//   node   benchmarks/engine/run.mjs --label v8        --out results/v8.json
//   bare   benchmarks/engine/run.mjs --label qjs       --out results/qjs.json
//   bare   benchmarks/engine/run.mjs --label jerry     --out results/jerry.json
//
// (Point `bare` at the engine via the BARE_ENGINE used to build it.) Then:
//
//   node   benchmarks/engine/compare.mjs results/v8.json results/qjs.json ...
//
// Pure JS, no deps — runs the same on every BARE_ENGINE binding.

import { detectEngine, runWorkload } from './harness.mjs'
import { buildWorkloads } from './workloads.mjs'

function parseArgs(argv) {
  const args = { out: '', label: '', scale: 1 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') args.out = argv[++i]
    else if (a === '--label') args.label = argv[++i]
    else if (a === '--scale') args.scale = Number(argv[++i]) || 1
  }
  return args
}

// argv differs across runtimes: node → process.argv.slice(2); bare → Bare.argv.slice(2).
function getArgv() {
  if (typeof process !== 'undefined' && Array.isArray(process.argv)) return process.argv.slice(2)
  if (typeof Bare !== 'undefined' && Array.isArray(Bare.argv)) return Bare.argv.slice(2)
  return []
}

async function writeOut(path, text) {
  if (!path) return false
  try {
    const fs = await import('fs')
    fs.writeFileSync(path, text)
    return true
  } catch {
    try {
      const bareFs = await import('bare-fs')
      ;(bareFs.default || bareFs).writeFileSync(path, text)
      return true
    } catch {
      return false
    }
  }
}

async function main() {
  const args = parseArgs(getArgv())
  const engine = detectEngine(args.label || (typeof process !== 'undefined' ? process.env?.BENCH_LABEL : ''))

  const workloads = await buildWorkloads({ scale: args.scale })
  const results = []
  for (const w of workloads) {
    const r = runWorkload(w)
    results.push(r)
    const ops = r.opsPerSec == null ? 'n/a' : String(r.opsPerSec).padStart(9)
    console.log(`  ${ops} ops/s  p99=${String(r.p99Ms).padStart(8)}ms  out=${r.out}  ${r.name}`)
  }

  const report = {
    label: engine.label,
    runtime: engine.runtime,
    engine: engine.engine,
    versions: engine.versions,
    scale: args.scale,
    timestamp: new Date().toISOString(),
    results,
  }

  console.log(`\nengine: ${report.engine}  runtime: ${report.runtime}  label: ${report.label}  scale: ${report.scale}`)
  const text = JSON.stringify(report, null, 2)
  if (args.out) {
    const ok = await writeOut(args.out, text)
    console.log(ok ? `wrote ${args.out}` : `could not write ${args.out} (printing to stdout)`) // eslint-disable-line
    if (!ok) console.log(text)
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err))
  if (typeof process !== 'undefined' && process.exit) process.exit(1)
})
