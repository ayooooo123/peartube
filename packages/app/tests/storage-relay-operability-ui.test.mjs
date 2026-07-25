import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  MAX_RENDERED_DIAGNOSTIC_ITEMS,
  buildArchiveOperatorView,
  buildStorageCategoryRows,
  buildStoragePreviewView,
  buildStorageLimitConfirmationCopy,
  getStorageLimitDecision,
  runStorageLimitChange,
} from '../lib/storage-operability.js'

const __dirname = path.dirname(new URL(import.meta.url).pathname)
const profileSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'profile.tsx'), 'utf8')
const storageDetailsSource = fs.readFileSync(path.join(__dirname, '..', 'components', 'StorageOperabilityDetails.tsx'), 'utf8')
const nativeSource = fs.readFileSync(path.join(__dirname, '..', 'components', 'native-diagnostics', 'DiagnosticsPanel.native.tsx'), 'utf8')
const webSource = fs.readFileSync(path.join(__dirname, '..', 'components', 'native-diagnostics', 'DiagnosticsPanel.web.tsx'), 'utf8')

test('storage categories distinguish protected archive pledges from safely evictable data', () => {
  const rows = buildStorageCategoryRows({
    ownedOriginalBytes: 100,
    immutablePublicationBytes: 200,
    pledgedArchiveBytes: 300,
    localCacheBytes: 400,
    thumbnailBytes: 50,
    indexBytes: 60,
    temporaryTransferBytes: 70,
    protectedBytes: 600,
    evictableBytes: 480,
  })

  assert.deepEqual(rows.map((row) => row.key), [
    'owned-originals',
    'published-media',
    'archive-pledges',
    'local-cache',
    'thumbnails',
    'indexes',
    'temporary-transfers',
  ])
  assert.equal(rows.find((row) => row.key === 'archive-pledges')?.protection, 'protected')
  assert.match(rows.find((row) => row.key === 'archive-pledges')?.detail ?? '', /pledge/i)
  assert.equal(rows.find((row) => row.key === 'local-cache')?.protection, 'evictable')
})

test('storage-limit decisions preview reductions, confirm feasible eviction, and block infeasible eviction', () => {
  assert.equal(getStorageLimitDecision({ currentMaxBytes: 20, requestedMaxBytes: 10 }).action, 'preview')

  const feasible = {
    success: true,
    feasible: true,
    requiredEvictionBytes: 8,
    evictableBytes: 12,
    protectedBytes: 5,
    affectedSeedCount: 2,
    affectedCategories: ['local-cache'],
    consequences: ['Cached copies may need to be fetched again.'],
  }
  assert.equal(getStorageLimitDecision({ currentMaxBytes: 20, requestedMaxBytes: 10, preview: feasible }).action, 'confirm')
  assert.equal(getStorageLimitDecision({ currentMaxBytes: 20, requestedMaxBytes: 10, preview: feasible, confirmed: true }).action, 'apply')

  const infeasible = { ...feasible, feasible: false, requiredEvictionBytes: 14 }
  assert.equal(getStorageLimitDecision({ currentMaxBytes: 20, requestedMaxBytes: 10, preview: infeasible }).action, 'blocked')
  assert.match(buildStoragePreviewView(infeasible).summary, /cannot be applied/i)
})

test('storage-limit flow never applies before confirmation or when eviction is infeasible', async () => {
  const feasible = {
    success: true,
    feasible: true,
    requiredEvictionBytes: 8,
    evictableBytes: 12,
    protectedBytes: 5,
    affectedSeedCount: 2,
    affectedCategories: ['local-cache'],
    consequences: ['Cached copies may need to be fetched again.'],
  }

  for (const confirmed of [false, true]) {
    let previewCalls = 0
    let confirmationCalls = 0
    let applyCalls = 0
    const result = await runStorageLimitChange({
      currentMaxBytes: 20,
      requestedMaxBytes: 10,
      previewStorageLimit: async () => { previewCalls += 1; return feasible },
      confirm: async () => { confirmationCalls += 1; return confirmed },
      apply: async () => { applyCalls += 1 },
    })
    assert.equal(previewCalls, 1)
    assert.equal(confirmationCalls, 1)
    assert.equal(applyCalls, confirmed ? 1 : 0)
    assert.equal(result.status, confirmed ? 'applied' : 'cancelled')
  }

  let infeasibleConfirmCalls = 0
  let infeasibleApplyCalls = 0
  const infeasibleResult = await runStorageLimitChange({
    currentMaxBytes: 20,
    requestedMaxBytes: 10,
    previewStorageLimit: async () => ({ ...feasible, feasible: false }),
    confirm: async () => { infeasibleConfirmCalls += 1; return true },
    apply: async () => { infeasibleApplyCalls += 1 },
  })
  assert.equal(infeasibleConfirmCalls, 0)
  assert.equal(infeasibleApplyCalls, 0)
  assert.equal(infeasibleResult.status, 'blocked')
})

test('eviction confirmation includes bounded affected categories and consequences', () => {
  const categories = Array.from({ length: MAX_RENDERED_DIAGNOSTIC_ITEMS + 2 }, (_, index) => `category-${index}`)
  const previewView = buildStoragePreviewView({
    success: true,
    feasible: true,
    requiredEvictionBytes: 8,
    evictableBytes: 12,
    protectedBytes: 5,
    affectedSeedCount: 2,
    affectedCategories: categories,
    consequences: ['Cached copies may need to be fetched again.'],
  })
  const copy = buildStorageLimitConfirmationCopy(previewView)
  assert.match(copy, /category-0/)
  assert.doesNotMatch(copy, /category-8/)
  assert.match(copy, /\+2 more affected categories/)
  assert.match(copy, /Cached copies may need to be fetched again/)
})

test('storage preview visibly renders bounded affected categories', () => {
  assert.match(storageDetailsSource, /affectedCategories\.map/)
  assert.match(storageDetailsSource, /hiddenCategoryCount/)
})

test('operator view names every mode and defaults unknown or absent status to untrusted local-first', () => {
  const modes = new Map([
    ['local-first', 'Local-first'],
    ['altruistic', 'Altruistic archive'],
    ['friend-family', 'Friends & family'],
    ['community', 'Community archive'],
    ['paid', 'Paid operator'],
  ])

  for (const [operatorMode, label] of modes) {
    assert.equal(buildArchiveOperatorView({ operatorMode }).modeLabel, label)
  }

  const fallback = buildArchiveOperatorView(null)
  assert.equal(fallback.mode, 'local-first')
  assert.match(fallback.trustCopy, /untrusted/i)
  assert.match(fallback.trustCopy, /local/i)
  assert.equal(buildArchiveOperatorView({ operatorMode: 'unexpected' }).mode, 'local-first')
})

test('operator view reports degraded pledges, challenge, capacity, and offload failures with a hard render bound', () => {
  const failureCodes = Array.from({ length: MAX_RENDERED_DIAGNOSTIC_ITEMS + 10 }, (_, index) => `FAILURE_${index}`)
  const view = buildArchiveOperatorView({
    operatorMode: 'community',
    activePledgeCount: 4,
    healthyPledgeCount: 2,
    failedPledgeCount: 1,
    challengeSuccessCount: 9,
    challengeFailureCount: 3,
    capacityTotalBytes: 1_000,
    capacityReservedBytes: 950,
    capacityAvailableBytes: 50,
    capacityRejectionCount: 2,
    offloadRejectionCount: 5,
    recentFailureCodes: failureCodes,
  })

  assert.equal(view.pledgeHealth, 'degraded')
  assert.match(view.pledgeCopy, /2 of 4 healthy/i)
  assert.match(view.challengeCopy, /3 failed/i)
  assert.match(view.capacityCopy, /2 rejected/i)
  assert.match(view.offloadCopy, /5 rejected/i)
  assert.equal(view.failureCodes.length, MAX_RENDERED_DIAGNOSTIC_ITEMS)
  assert.equal(view.hiddenFailureCount, 10)
})

test('operator failure envelopes remain visible instead of becoming a healthy fallback', () => {
  const view = buildArchiveOperatorView({
    success: false,
    errorCode: 'ARCHIVE_STATUS_UNAVAILABLE',
  })
  assert.equal(view.mode, 'local-first')
  assert.deepEqual(view.failureCodes, ['ARCHIVE_STATUS_UNAVAILABLE'])
})

test('native and web diagnostics render the shared bounded archive operator view', () => {
  for (const source of [nativeSource, webSource]) {
    assert.match(source, /ArchiveOperatorDiagnostics/)
    assert.match(source, /operatorStatus=/)
  }
})

test('profile isolates diagnostic RPC failures so archive failures still render', () => {
  assert.match(profileSource, /getSwarmStatus\(\)\.catch\(\(\) => null\)/)
  assert.match(profileSource, /getSeedingStatus\(\)\.catch\(\(\) => null\)/)
  assert.match(profileSource, /getArchiveOperatorStatus\(\)\.catch\(\(\) => null\)/)
})

test('profile previews lowered limits and only applies feasible eviction after explicit confirmation', () => {
  assert.match(profileSource, /previewStorageLimit/)
  assert.match(profileSource, /requestStorageLimitConfirmation/)
  assert.match(profileSource, /runStorageLimitChange/)
  assert.match(profileSource, /StorageOperabilityDetails/)
})
