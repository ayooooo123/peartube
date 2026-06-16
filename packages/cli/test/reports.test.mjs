import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ReportStore } from '../src/reports.js'

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('ReportStore persists local moderation reports', async (t) => {
  const dir = makeTempDir('peartube-relay-reports-')
  const reportsPath = join(dir, 'db', 'relay-reports.json')

  try {
    const store = await ReportStore.open({
      storagePath: dir,
      reportsPath,
      nowFn: () => 1234
    })

    const report = await store.addReport({
      targetType: 'blobCore',
      target: 'blob-core-1',
      reason: 'spam',
      comment: 'unexpected preview',
      reporter: 'local'
    })

    t.ok(report.id.startsWith('report_'))
    t.alike(report, {
      id: report.id,
      targetType: 'blobsCoreKey',
      target: 'blob-core-1',
      reason: 'spam',
      comment: 'unexpected preview',
      reporter: 'local',
      createdAt: 1234
    })

    const reloaded = await ReportStore.open({ storagePath: dir, reportsPath })
    t.alike(reloaded.getReports(), [report])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ReportStore rejects unsupported report reasons', async (t) => {
  const dir = makeTempDir('peartube-relay-report-validation-')

  try {
    const store = await ReportStore.open({ storagePath: dir })

    await t.exception(async () => store.addReport({
      targetType: 'channel',
      target: 'chan-1',
      reason: 'surprise'
    }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
