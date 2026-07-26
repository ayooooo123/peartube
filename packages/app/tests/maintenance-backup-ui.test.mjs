import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const modelUrl = new URL('../components/maintenance/maintenance-model.mjs', import.meta.url)
const fileTransferUrl = new URL('../lib/maintenance-file-transfer.mjs', import.meta.url)
const panelUrl = new URL('../components/maintenance/MigrationBackupPanel.tsx', import.meta.url)
const routeUrl = new URL('../app/maintenance.tsx', import.meta.url)
const profileUrl = new URL('../app/profile.tsx', import.meta.url)
const developerSettingsUrl = new URL('../app/developer-settings.tsx', import.meta.url)

async function importRequired(url, label) {
  try {
    return await import(url)
  } catch (error) {
    assert.fail(`${label} must exist and be importable: ${error?.message || error}`)
  }
}

async function readRequired(url, label) {
  try {
    return await readFile(url, 'utf8')
  } catch (error) {
    assert.fail(`${label} must exist and be readable: ${error?.message || error}`)
  }
}

test('migration presentation covers every lifecycle state and all bounded counters', async () => {
  const { migrationPresentation, migrationCounterRows, boundedDiagnosticCode, boundedError } = await importRequired(modelUrl, 'maintenance model')

  assert.deepEqual(
    ['pending', 'running', 'retrying', 'complete', 'failed'].map((state) => migrationPresentation(state).label),
    ['Waiting to start', 'Import in progress', 'Retry in progress', 'Migration complete', 'Migration failed'],
  )

  assert.deepEqual(
    migrationCounterRows({
      processedCount: 12,
      importedCount: 7,
      skippedCount: 2,
      quarantinedCount: 1,
      unsupportedCount: 1,
      remainingCount: 1,
    }),
    [
      ['Processed', 12],
      ['Imported', 7],
      ['Skipped', 2],
      ['Quarantined', 1],
      ['Unsupported', 1],
      ['Remaining', 1],
    ],
  )
  assert.equal(migrationCounterRows({ processedCount: Number.MAX_SAFE_INTEGER })[0][1], 1_000_000_000)
  assert.equal(boundedError(new Error('x'.repeat(500))).length, 240)
  assert.equal(boundedError({ code: 'PRIVATE_ROOT', privateKey: 'secret' }), 'Maintenance action failed')
  assert.equal(boundedDiagnosticCode(`\u0000${'X'.repeat(100)}`).length, 64)
  assert.equal(boundedDiagnosticCode(null), 'MIGRATION_FAILED')
})

test('retry is gated to a retryable failed migration and refreshes through the injected RPC', async () => {
  const { canRetryMigration, createMaintenanceActions } = await importRequired(modelUrl, 'maintenance model')
  assert.equal(canRetryMigration({ state: 'failed', retryable: true }), true)
  assert.equal(canRetryMigration({ state: 'failed', retryable: false }), false)
  assert.equal(canRetryMigration({ state: 'running', retryable: true }), false)
  assert.equal(canRetryMigration(null), false)

  const calls = []
  const statusCalls = []
  const actions = createMaintenanceActions({
    rpc: {
      getMigrationStatus: async (request) => {
        statusCalls.push(request)
        return { success: true, migrationId: request.migrationId, state: 'pending', retryable: false }
      },
      retryMigration: async (request) => {
        calls.push(request)
        return { success: true, migrationId: request.migrationId, state: 'retrying', retryable: false }
      },
    },
    files: {},
  })
  const status = await actions.getMigrationStatus()
  assert.equal(status.state, 'pending')
  assert.deepEqual(statusCalls, [{ migrationId: 'publication-v1' }])
  await assert.rejects(() => actions.retryMigration({ state: 'running', retryable: true }), /not retryable/i)
  const result = await actions.retryMigration({ state: 'failed', retryable: true })
  assert.equal(result.state, 'retrying')
  assert.deepEqual(calls, [{ migrationId: 'publication-v1' }])
})

test('maintenance capabilities fail closed for every missing RPC and file adapter', async () => {
  const { maintenanceCapabilities } = await importRequired(modelUrl, 'maintenance model')
  const unavailable = maintenanceCapabilities({ rpc: {}, files: {} })
  assert.deepEqual(
    Object.fromEntries(Object.entries(unavailable).map(([name, capability]) => [name, capability.available])),
    { status: false, retry: false, report: false, export: false, select: false, restore: false },
  )
  for (const capability of Object.values(unavailable)) {
    assert.match(capability.reason, /unavailable/i)
  }

  assert.equal(
    maintenanceCapabilities({ rpc: {}, files: { save() {}, select() {} } }).select.available,
    false,
    'file selection must not lead into a restore flow with no restore RPC',
  )

  const available = maintenanceCapabilities({
    rpc: {
      getMigrationStatus() {},
      retryMigration() {},
      exportMigrationReport() {},
      exportPortableState() {},
      restorePortableState() {},
    },
    files: { save() {}, select() {} },
  })
  assert.equal(Object.values(available).every((capability) => capability.available), true)
})

test('migration reports and portable state are saved as real files without secret material', async () => {
  const { createMaintenanceActions } = await importRequired(modelUrl, 'maintenance model')
  const saved = []
  const manifestBytes = new TextEncoder().encode('{"subscriptions":["alice"]}')
  const portableExportCalls = []
  const reportCalls = []
  const actions = createMaintenanceActions({
    rpc: {
      exportMigrationReport: async (request) => {
        reportCalls.push(request)
        return ({
        success: true,
        migrationId: 'publication-v1',
        reportBytes: new TextEncoder().encode('{"state":"complete"}'),
        reportDigest: 'report-digest',
        })
      },
      exportPortableState: async (...args) => {
        portableExportCalls.push(args)
        return ({
        success: true,
        schemaVersion: 3,
        manifestBytes,
        manifestDigest: 'manifest-digest',
        itemCount: 1,
        privateRoot: 'must-not-export',
        signingKey: 'must-not-export',
        })
      },
    },
    files: {
      save: async (file) => {
        saved.push(file)
        return { fileName: file.fileName }
      },
    },
  })

  await actions.saveMigrationReport()
  await actions.savePortableState()
  assert.deepEqual(portableExportCalls, [[]], 'the flat platform RPC accepts no export request object')
  assert.deepEqual(reportCalls, [{ migrationId: 'publication-v1' }])
  assert.equal(saved[0].fileName, 'peartube-publication-v1-migration-report.json')
  assert.deepEqual(saved[0].bytes, new TextEncoder().encode('{"state":"complete"}'))
  assert.equal(saved[1].fileName, 'peartube-portable-state.json')
  const portableText = new TextDecoder().decode(saved[1].bytes)
  assert.match(portableText, /"manifestDigest":"manifest-digest"/)
  assert.doesNotMatch(portableText, /privateRoot|signingKey|must-not-export|recovery|secret/i)
})

test('portable restore selects a file, forwards its checksum for server verification, and preserves failures', async () => {
  const { createMaintenanceActions, createPortableEnvelope } = await importRequired(modelUrl, 'maintenance model')
  const sourceBytes = new Uint8Array([1, 2, 3, 4])
  const envelope = createPortableEnvelope({ schemaVersion: 2, manifestBytes: sourceBytes, manifestDigest: 'sha256:abcd' })
  const requests = []
  const actions = createMaintenanceActions({
    rpc: {
      restorePortableState: async (request) => {
        requests.push(request)
        return { success: true, schemaVersion: 2, importedCount: 3, skippedCount: 1, idempotent: false }
      },
    },
    files: {
      select: async () => ({ fileName: 'portable.json', bytes: envelope }),
    },
  })

  const selection = await actions.selectPortableState()
  assert.equal(selection.fileName, 'portable.json')
  assert.equal(selection.manifestDigest, 'sha256:abcd')
  const restored = await actions.restorePortableState(selection)
  assert.equal(restored.importedCount, 3)
  assert.deepEqual(requests, [{ manifestBytes: sourceBytes, manifestDigest: 'sha256:abcd' }])

  const failing = createMaintenanceActions({
    rpc: {
      restorePortableState: async () => ({ success: false, errorCode: 'PORTABLE_DIGEST_MISMATCH', error: 'checksum mismatch' }),
    },
    files: { select: async () => ({ fileName: 'portable.json', bytes: envelope }) },
  })
  const failedSelection = await failing.selectPortableState()
  await assert.rejects(() => failing.restorePortableState(failedSelection), /PORTABLE_DIGEST_MISMATCH.*checksum mismatch/i)

  const invalid = createMaintenanceActions({
    rpc: { restorePortableState: async () => assert.fail('invalid file must not reach the server') },
    files: { select: async () => ({ fileName: 'bad.json', bytes: new TextEncoder().encode('{"manifestBytes":"broken"}') }) },
  })
  await assert.rejects(() => invalid.selectPortableState(), /invalid portable state file/i)
})

test('file helper executes bounded web and native save/select branches', async () => {
  const { saveBytesToFile, selectBytesFromFile } = await importRequired(fileTransferUrl, 'maintenance file helper')
  const bytes = new Uint8Array([80, 101, 97, 114])
  const webCalls = []
  const webResult = await saveBytesToFile({
    platform: 'web',
    bytes,
    fileName: 'report.json',
    mimeType: 'application/json',
    web: {
      createBlob: (parts, options) => ({ parts, options }),
      createObjectURL: (blob) => { webCalls.push(['url', blob]); return 'blob:report' },
      revokeObjectURL: (url) => webCalls.push(['revoke', url]),
      clickDownload: (url, name) => webCalls.push(['click', url, name]),
    },
  })
  assert.equal(webResult.fileName, 'report.json')
  assert.deepEqual(webCalls.map((call) => call[0]), ['url', 'click', 'revoke'])

  const nativeCalls = []
  await saveBytesToFile({
    platform: 'ios',
    bytes,
    fileName: 'portable.json',
    native: {
      writeBase64File: async (name, base64) => { nativeCalls.push(['write', name, base64]); return 'file:///portable.json' },
      shareFile: async (uri, name) => nativeCalls.push(['share', uri, name]),
    },
  })
  assert.deepEqual(nativeCalls, [
    ['write', 'portable.json', 'UGVhcg=='],
    ['share', 'file:///portable.json', 'portable.json'],
  ])

  const selectedWeb = await selectBytesFromFile({
    platform: 'web',
    pickDocument: async () => ({ canceled: false, assets: [{ name: 'web.json', size: 4, file: { arrayBuffer: async () => bytes.buffer } }] }),
  })
  assert.deepEqual(selectedWeb, { fileName: 'web.json', bytes })

  const selectedNative = await selectBytesFromFile({
    platform: 'android',
    pickDocument: async () => ({ canceled: false, assets: [{ name: 'native.json', size: 4, uri: 'content://portable' }] }),
    native: { readBase64File: async (uri, maxBytes) => {
      assert.equal(uri, 'content://portable')
      assert.equal(maxBytes, 1_500_000)
      return 'UGVhcg=='
    } },
  })
  assert.deepEqual(selectedNative, { fileName: 'native.json', bytes })
  await assert.rejects(
    () => selectBytesFromFile({ platform: 'web', maxBytes: 3, pickDocument: async () => ({ canceled: false, assets: [{ name: 'huge.json', size: 4, file: { arrayBuffer: async () => bytes.buffer } }] }) }),
    /too large/i,
  )
  await assert.rejects(
    () => selectBytesFromFile({
      platform: 'web',
      maxBytes: 3,
      pickDocument: async () => ({
        canceled: false,
        assets: [{
          name: 'huge.json',
          file: {
            size: 4,
            arrayBuffer: async () => assert.fail('oversized web file must be rejected before reading'),
          },
        }],
      }),
    }),
    /too large/i,
  )
})

test('maintenance route injects RPC, is gated, and is linked only from Developer Settings', async () => {
  const [route, panel, profile, developerSettings] = await Promise.all([
    readRequired(routeUrl, 'maintenance route'),
    readRequired(panelUrl, 'maintenance panel'),
    readRequired(profileUrl, 'profile route'),
    readRequired(developerSettingsUrl, 'Developer Settings route'),
  ])

  assert.match(route, /<MigrationBackupPanel\s+rpc=\{rpc\}/)
  assert.match(panel, /getMigrationStatus/)
  assert.match(panel, /saveMigrationReport/)
  assert.match(panel, /savePortableState/)
  assert.match(panel, /selectPortableState/)
  assert.match(panel, /restorePortableState/)
  assert.match(panel, /\{selection \?[\s\S]*Confirm destructive restore[\s\S]*Verify & restore/)
  assert.match(panel, /checksum/i)
  assert.match(panel, /boundedDiagnosticCode\(status\.errorCode/)
  assert.match(panel, /accessibilityHint=\{capabilities\.retry\.reason/)
  assert.match(panel, /capabilities\.report\.available/)
  assert.match(panel, /capabilities\.export\.available/)
  assert.match(panel, /capabilities\.select\.available/)
  assert.match(panel, /capabilities\.restore\.available/)
  assert.match(panel, /CapabilityReason/)
  assert.ok(
    route.indexOf('FileSystem.getInfoAsync') < route.indexOf('FileSystem.readAsStringAsync'),
    'native imports must check the selected file size before reading it',
  )
  assert.match(panel, /Private publisher root/)
  assert.match(panel, /Device-local/)
  assert.match(route, /DeveloperModeGate/)
  assert.doesNotMatch(profile, /router\.push\('\/maintenance'\)/)
  assert.match(developerSettings, /path: '\/maintenance'/)
})
