// Compare two or more result files produced by run.mjs. The FIRST file is the
// baseline (normally V8); the rest are candidates (QuickJS, Jerry, JSC, …).
//
//   node benchmarks/engine/compare.mjs results/v8.json results/qjs.json results/jerry.json
//
// Reports, per workload: baseline ops/s, each candidate's ops/s, the slowdown
// factor, and — most importantly — whether the output checksum MATCHES the
// baseline. A checksum mismatch means the engine computed a different result:
// a correctness bug, which matters far more than any speed delta.

import fs from 'fs'

function load(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}

function pad(s, n) {
  s = String(s)
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}
function padL(s, n) {
  s = String(s)
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

function main() {
  const paths = process.argv.slice(2)
  if (paths.length < 2) {
    console.error('usage: compare.mjs <baseline.json> <candidate.json> [more.json ...]')
    process.exit(2)
  }
  const reports = paths.map(load)
  const baseline = reports[0]
  const candidates = reports.slice(1)

  console.log(`\nbaseline: ${baseline.label} (${baseline.engine})  scale=${baseline.scale}\n`)

  const byName = new Map()
  for (const r of baseline.results) byName.set(r.name, { base: r, cand: [] })
  for (const c of candidates) {
    for (const r of c.results) {
      const row = byName.get(r.name)
      if (row) row.cand.push({ label: c.label, r })
    }
  }

  const labels = candidates.map((c) => c.label)
  console.log(
    pad('workload', 46) +
      padL(`${baseline.label} ops/s`, 16) +
      labels.map((l) => padL(`${l} ops/s`, 14) + padL('x', 7) + padL('ok', 4)).join('')
  )
  console.log('-'.repeat(46 + 16 + labels.length * 25))

  const slowdowns = Object.fromEntries(labels.map((l) => [l, []]))
  let mismatches = 0

  for (const [name, row] of byName) {
    let line = pad(name, 46) + padL(row.base.opsPerSec ?? 'n/a', 16)
    for (const { label, r } of row.cand) {
      const ratio = row.base.opsPerSec && r.opsPerSec ? r.opsPerSec / row.base.opsPerSec : null
      const slow = ratio ? 1 / ratio : null
      if (slow) slowdowns[label].push(slow)
      const ok = r.out === row.base.out
      if (!ok) mismatches++
      line += padL(r.opsPerSec ?? 'n/a', 14) + padL(slow ? slow.toFixed(2) + 'x' : '-', 7) + padL(ok ? 'OK' : 'DIFF', 4)
    }
    console.log(line)
  }

  console.log('\nGeometric-mean slowdown vs baseline (lower is better, 1.00 = parity):')
  for (const label of labels) {
    const arr = slowdowns[label]
    const geo = arr.length ? Math.exp(arr.reduce((a, v) => a + Math.log(v), 0) / arr.length) : 0
    console.log(`  ${pad(label, 12)} ${geo.toFixed(2)}x slower`)
  }

  if (mismatches > 0) {
    console.log(`\n‼  ${mismatches} workload(s) produced a DIFFERENT checksum than the baseline.`)
    console.log('   This is a CORRECTNESS divergence — investigate before shipping the engine swap.')
    process.exit(1)
  } else {
    console.log('\n✓  All candidate checksums match the baseline (no correctness divergence detected).')
  }
}

main()
