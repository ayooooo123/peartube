// Home relay latency and counter samples for the Fargate test.
//
// One call samples every relay once. `prepare` calls it twenty times for the
// baseline; `watch` calls it on its own cadence. Each sample is appended as one
// JSON line. A relay URL and any failure detail stay out of the file: the relay's
// position in the operator's list is all a result row records.

import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const SAMPLE_TIMEOUT_MS = 5000

function finite (value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export async function sampleHome ({ urls, resultsDir }) {
  if (!Array.isArray(urls) || urls.length === 0) throw new Error('home relay URLs are required')
  if (typeof resultsDir !== 'string' || !resultsDir) throw new Error('resultsDir is required')
  await mkdir(resultsDir, { recursive: true })
  const file = path.join(resultsDir, 'home.jsonl')
  const samples = []

  for (let i = 0; i < urls.length; i++) {
    const started = Date.now()
    const sample = {
      type: 'home',
      relay: String(i),
      ts: started,
      ms: 0,
      upBps: null,
      txBytes: null,
      peers: null,
      ok: false
    }
    try {
      const base = String(urls[i]).trim().replace(/\/+$/, '')
      const res = await fetch(`${base}/v1/status`, {
        signal: AbortSignal.timeout(SAMPLE_TIMEOUT_MS),
        headers: { accept: 'application/json' },
        redirect: 'error'
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const status = await res.json()
      sample.ms = Date.now() - started
      if (status && typeof status === 'object') {
        sample.upBps = finite(status.upBps)
        sample.txBytes = finite(status.txBytes)
        sample.peers = finite(status.peers)
        sample.ok = sample.upBps !== null && sample.txBytes !== null && sample.peers !== null
      }
    } catch {
      // The sample stays ok:false with null counters. No address or message is recorded.
      sample.ms = Date.now() - started
    }
    await appendFile(file, JSON.stringify(sample) + '\n')
    samples.push(sample)
  }

  return samples
}
