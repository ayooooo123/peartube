import test from 'brittle'
import { matchSources } from '../src/add/bulk/matcher.js'

// Deterministic PRNG so shuffles are reproducible across runs.
function mulberry32 (seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle (items, rng) {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function buildFixtures (count) {
  const targets = []
  const sources = []
  for (let i = 1; i <= count; i += 1) {
    targets.push({ id: `t${i}`, seasonNumber: 1, episodeNumber: i, title: `Episode ${i}`, sourceProvider: 'tmdb', sourceVideoId: `ep-${i}` })
    sources.push({ id: `s${i}`, sourceProvider: 'tmdb', sourceVideoId: `ep-${i}`, filename: `show.S01E${String(i).padStart(2, '0')}.mkv` })
  }
  return { targets, sources }
}

test('accepted mappings are injective in both directions', (t) => {
  const rng = mulberry32(42)
  for (let trial = 0; trial < 25; trial += 1) {
    const { targets, sources } = buildFixtures(6)
    const result = matchSources({ sources: shuffle(sources, rng), targets: shuffle(targets, rng) })
    const sourceSet = new Set()
    const targetSet = new Set()
    for (const assignment of result.assignments) {
      t.absent(sourceSet.has(assignment.sourceId), 'each source assigned at most once')
      t.absent(targetSet.has(assignment.targetId), 'each target assigned at most once')
      sourceSet.add(assignment.sourceId)
      targetSet.add(assignment.targetId)
    }
  }
})

test('assignments are deterministic under input reordering', (t) => {
  const rng = mulberry32(7)
  const { targets, sources } = buildFixtures(5)
  const canonical = matchSources({ sources, targets }).assignments
    .map((a) => `${a.sourceId}->${a.targetId}`).sort()
  for (let trial = 0; trial < 20; trial += 1) {
    const shuffled = matchSources({ sources: shuffle(sources, rng), targets: shuffle(targets, rng) }).assignments
      .map((a) => `${a.sourceId}->${a.targetId}`).sort()
    t.alike(shuffled, canonical, 'same mapping regardless of order')
  }
})

test('equal-confidence ambiguity never auto-accepts', (t) => {
  const targets = [
    { id: 't1', title: 'Same' },
    { id: 't2', title: 'Same' }
  ]
  const sources = [
    { id: 's1', title: 'Same' },
    { id: 's2', title: 'Same' }
  ]
  const rng = mulberry32(99)
  for (let trial = 0; trial < 20; trial += 1) {
    const result = matchSources({ sources: shuffle(sources, rng), targets: shuffle(targets, rng) })
    t.is(result.assignments.length, 0, 'ambiguous equal-confidence stays unresolved')
  }
})
