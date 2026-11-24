import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSoulseekPlugin } from '../src/providers/soulseek.js'

function makeFakeAddon (calls, scripts) {
  return async () => ({
    Soulseek: class {
      state () {
        return { connected: true, logged_in: true, listen_port: 0 }
      }

      async login () {
        return { connected: true, logged_in: true, listen_port: 0 }
      }

      async download (_user, filename, dest, onProgress) {
        calls.push(filename)
        const queue = scripts.get(filename)
        if (!queue || !queue.length) throw new Error('unexpected download call')
        const step = queue.shift()
        if (step.error) throw new Error(step.error)
        const data = Buffer.from(step.data)
        writeFileSync(dest, data)
        onProgress?.({ phase: 'completed', bytes: data.length, total: data.length })
        return { size: data.length }
      }

      close () {}
    }
  })
}

test('durable soulseek job persists progress on failure and resumes across restart and retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-slsk-durable-'))
  try {
    const calls = []
    const scripts = new Map([
      ['Music\\Album\\01 - First.flac', [{ data: 'track-one-bytes' }]],
      [
        'Music\\Album\\02 - Second.flac',
        [
          { error: 'upload denied by peer: temporarily unavailable' },
          { data: 'track-two-bytes!' }
        ]
      ]
    ])

    const makePlugin = () => createSoulseekPlugin({
      storage: dir,
      slskUser: 'tester',
      slskPass: 'secret',
      persistJobs: true,
      loadAddon: makeFakeAddon(calls, scripts)
    })

    const first = makePlugin()
    await assert.rejects(
      first.mirror({
        username: 'peer1',
        title: 'Test Artist - Test Album (2024)',
        files: [
          { filename: 'Music\\Album\\01 - First.flac', size: 15 },
          { filename: 'Music\\Album\\02 - Second.flac', size: 16 }
        ],
        wait: true
      }),
      /refused the file/
    )

    const listed = first.listJobs()
    assert.equal(listed.length, 1)
    const jobId = listed[0].jobId
    assert.equal(listed[0].status, 'failed')
    assert.equal(listed[0].retryable, true)
    assert.ok(existsSync(join(dir, `.slsk-job-${jobId}`)))
    assert.ok(existsSync(join(dir, 'soulseek-jobs.json')))
    await first.stop()

    const second = makePlugin()
    const restored = second.listJobs()
    assert.equal(restored.length, 1)
    assert.equal(restored[0].jobId, jobId)
    assert.equal(restored[0].status, 'failed')
    assert.equal(restored[0].bytes, 15)

    const retried = second.retryJob(jobId)
    assert.equal(retried.status, 'queued')

    const deadline = Date.now() + 5000
    while (Date.now() < deadline && second.getJob(jobId)?.status !== 'done') {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const done = second.getJob(jobId)
    assert.equal(done.status, 'done')
    assert.equal(done.bytes, 31)
    assert.ok(!existsSync(join(dir, `.slsk-job-${jobId}`)))
    assert.deepEqual(calls, [
      'Music\\Album\\01 - First.flac',
      'Music\\Album\\02 - Second.flac',
      'Music\\Album\\02 - Second.flac'
    ])
    await second.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('durable soulseek job wakes immediately from retry backoff on wakeJobs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-slsk-wake-'))
  try {
    const calls = []
    const scripts = new Map([
      [
        'Music\\Single\\01 - Wake.flac',
        [
          { error: 'peer stopped sending: stalled' },
          { data: 'resumed-audio' }
        ]
      ]
    ])
    const plug = createSoulseekPlugin({
      storage: dir,
      slskUser: 'tester',
      slskPass: 'secret',
      persistJobs: true,
      loadAddon: makeFakeAddon(calls, scripts)
    })

    const queued = await plug.mirror({
      username: 'peer2',
      title: 'Wake Artist - Wake Album (2024)',
      files: [{ filename: 'Music\\Single\\01 - Wake.flac', size: 13 }]
    })
    const jobId = queued.job.jobId

    const waitRetrying = Date.now() + 2000
    while (Date.now() < waitRetrying && plug.getJob(jobId)?.phase !== 'retrying') {
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    assert.equal(plug.getJob(jobId)?.phase, 'retrying')

    const active = plug.wakeJobs()
    assert.equal(active, 1)

    const waitDone = Date.now() + 2000
    while (Date.now() < waitDone && plug.getJob(jobId)?.status !== 'done') {
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    assert.equal(plug.getJob(jobId)?.status, 'done')
    assert.equal(calls.length, 2)
    await plug.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
