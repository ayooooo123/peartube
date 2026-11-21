// Reads the dht-prometheus scraper for the Fargate test.
//
// Target file shape (dht-prometheus v2.0.0):
//   [{ "labels": { "job": "aliases" },
//      "targets": ["alias:z32PublicKey:hostname:service"] }]
//
// Only the alias is used and saved. The public key, hostname and service never
// leave the target file. The scraper serves each alias at
//   GET /scrape/<encodeURIComponent(alias)>/metrics
// and it must be given DHT_PROM_PROMETHEUS_TARGETS_LOC=<runDir>/targets.json by
// the process launcher.

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isIP } from 'node:net'

// Only task addresses belong in repository artifacts. Other addresses can be a home relay.
export function scrubArtifact (value, taskIps = new Set()) {
  if (Array.isArray(value)) return value.map(item => scrubArtifact(item, taskIps))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrubArtifact(key, taskIps), scrubArtifact(item, taskIps)]))
  if (typeof value !== 'string') return value
  let text = value.replace(/arn:aws:[^"\s]*/g, arn => arn.split('/').pop().slice(0, 8))
    .replace(/\b\d{12}\b/g, '[account]')
    .replace(/\b[0-9a-f]{32}\b/gi, id => id.slice(0, 8))
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, '/[home]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, ip => taskIps.has(ip) ? ip : '[address]')
    .replace(/(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/gi, ip => isIP(ip) && !taskIps.has(ip) ? '[address]' : ip)
  for (const url of (process.env.PT_HOME_RELAYS || '').split(',').filter(Boolean)) {
    try { const host = new URL(url).hostname; if (host) text = text.split(host).join('[home-relay]') } catch {}
  }
  return text
}

const SCRAPE_TIMEOUT_MS = 5000
const METRIC_NAME_START = /[a-zA-Z_:]/
const METRIC_NAME_CHAR = /[a-zA-Z0-9_:]/
const LABEL_NAME_START = /[a-zA-Z_]/
const LABEL_NAME_CHAR = /[a-zA-Z0-9_]/
const NUMBER = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/

const isSpace = ch => ch === ' ' || ch === '\t' || ch === '\r'
const isNameStart = ch => METRIC_NAME_START.test(ch)
const isNameChar = ch => METRIC_NAME_CHAR.test(ch)
const isLabelStart = ch => LABEL_NAME_START.test(ch)
const isLabelChar = ch => LABEL_NAME_CHAR.test(ch)

// Prometheus label escaping. The result is a key fragment such as
// mode="video",kind="media" with the two labels sorted by name.
function escapeLabel (value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
}

// Parses one `{name="value",...}` label block starting at `start`. A `}` inside
// a quoted value is data, not the end of the block. Returns null on a malformed
// block; the caller skips the whole line rather than guessing.
function parseLabels (text, start) {
  const labels = []
  let i = start + 1
  while (i < text.length) {
    while (i < text.length && isSpace(text[i])) i++
    if (i >= text.length) return null
    if (text[i] === '}') return { labels, end: i + 1 }
    if (!isLabelStart(text[i])) return null
    const nameStart = i
    i++
    while (i < text.length && isLabelChar(text[i])) i++
    const name = text.slice(nameStart, i)
    while (i < text.length && isSpace(text[i])) i++
    if (text[i] !== '=') return null
    i++
    while (i < text.length && isSpace(text[i])) i++
    if (text[i] !== '"') return null
    i++
    let value = ''
    let closed = false
    while (i < text.length) {
      const ch = text[i++]
      if (ch === '\\') {
        if (i >= text.length) return null
        const next = text[i++]
        value += next === 'n' ? '\n' : next === '"' ? '"' : next === '\\' ? '\\' : next
      } else if (ch === '"') {
        closed = true
        break
      } else {
        value += ch
      }
    }
    if (!closed) return null
    labels.push([name, value])
    while (i < text.length && isSpace(text[i])) i++
    if (text[i] === ',') { i++; continue }
    if (text[i] === '}') return { labels, end: i + 1 }
    return null
  }
  return null
}

function setMetric (metrics, name, value) {
  Object.defineProperty(metrics, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  })
}

// Parses Prometheus text exposition into the scrape line's `metrics` object.
// An unlabelled series is a number; labelled series of one metric name become
// an object keyed by the canonical label set, for example:
//   { "blind_relay_sessions": 3,
//     "blind_relay_streams": { "kind=\"direct\"": 2, "kind=\"relayed\"": 1 } }
// Non-finite values (NaN, +Inf, -Inf) are skipped: JSON has no such numbers.
export function parsePrometheus (text) {
  const metrics = {}
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (!line || line[0] === '#') continue
    if (!isNameStart(line[0])) continue

    let i = 1
    while (i < line.length && isNameChar(line[i])) i++
    const name = line.slice(0, i)

    let labels = null
    if (line[i] === '{') {
      const parsed = parseLabels(line, i)
      if (!parsed) continue
      labels = parsed.labels
      i = parsed.end
    }

    while (i < line.length && isSpace(line[i])) i++
    if (i >= line.length) continue
    let end = i
    while (end < line.length && !isSpace(line[end])) end++
    const token = line.slice(i, end)
    if (!NUMBER.test(token)) continue
    const value = Number(token)
    if (!Number.isFinite(value)) continue

    if (!labels || labels.length === 0) {
      const current = Object.prototype.hasOwnProperty.call(metrics, name) ? metrics[name] : undefined
      if (current && typeof current === 'object') {
        // A family that already has labelled series keeps them; the unlabelled
        // series takes the empty label set.
        current[''] = value
        setMetric(metrics, name, current)
      } else {
        setMetric(metrics, name, value)
      }
      continue
    }

    labels.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    const key = labels.map(([label, labelValue]) => `${label}="${escapeLabel(labelValue)}"`).join(',')
    let group
    if (Object.prototype.hasOwnProperty.call(metrics, name)) {
      const current = metrics[name]
      // An unlabelled series keeps its place under the empty label set.
      group = typeof current === 'number' ? { '': current } : current
    } else {
      group = {}
    }
    group[key] = value
    setMetric(metrics, name, group)
  }
  return metrics
}

// The aliases in the target file. Only the first field of each target is kept;
// everything after it, including the hostname, is discarded here.
async function readAliases (runDir) {
  let text
  try {
    text = await readFile(path.join(runDir, 'targets.json'), 'utf8')
  } catch {
    throw new Error('scraper targets file is missing')
  }
  let groups
  try {
    groups = JSON.parse(text)
  } catch {
    throw new Error('scraper targets file is not JSON')
  }
  if (!Array.isArray(groups)) throw new Error('scraper targets file is not an array')

  const aliases = []
  for (const group of groups) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.targets)) continue
    for (const target of group.targets) {
      if (typeof target !== 'string') continue
      const colon = target.indexOf(':')
      if (colon <= 0) continue
      const alias = target.slice(0, colon)
      if (!/^[A-Za-z0-9._-]+$/.test(alias) || alias === '.' || alias === '..') continue
      aliases.push(alias)
    }
  }
  const unique = [...new Set(aliases)]
  if (unique.length === 0) throw new Error('scraper targets file lists no aliases')
  return unique
}

// Scrapes every alias once and appends a line per successful alias. Returns one
// record per alias: { alias, ok, ts, metrics? }. A target that cannot be read is
// ok:false and writes no line, so a failed scrape is never mistaken for metrics.
// If no alias reaches the scraper at all (it is down or hung), the call rejects
// and the error carries `results`. A missing or malformed target file rejects.
export async function scrapeTargets ({ run, runDir, resultsDir, port }) {
  if (typeof run !== 'string' || !run) throw new Error('run is required')
  if (typeof runDir !== 'string' || !runDir) throw new Error('runDir is required')
  if (typeof resultsDir !== 'string' || !resultsDir) throw new Error('resultsDir is required')
  const listenPort = Number(port)
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error('scraper port is invalid')
  }

  const aliases = await readAliases(runDir)
  await mkdir(resultsDir, { recursive: true })
  const file = path.join(resultsDir, 'scrape.jsonl')
  const ts = Date.now()

  // One round must fit the watch cadence, so every alias is fetched at once and
  // the lines are appended afterwards in the target file's order.
  const attempts = await Promise.all(aliases.map(async alias => {
    const url = `http://127.0.0.1:${listenPort}/scrape/${encodeURIComponent(alias)}/metrics`
    let res
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
        headers: { accept: 'text/plain' },
        redirect: 'error'
      })
    } catch {
      return { answered: false, record: { alias, ok: false, ts } }
    }
    // A resolved fetch proves the scraper is listening, even when this alias
    // answers 404 or 500.
    try {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const type = res.headers.get('content-type') || ''
      if (type && !/text\/plain|openmetrics-text/i.test(type)) throw new Error('not Prometheus text')
      const metrics = scrubArtifact(parsePrometheus(await res.text()))
      const line = scrubArtifact({ v: 1, type: 'scrape', run, ts, alias, metrics })
      return { answered: true, line, record: { alias: line.alias, ok: true, ts, metrics } }
    } catch {
      // Keep ok:false, with no address and no error text. Nothing is appended.
      return { answered: true, record: { alias, ok: false, ts } }
    }
  }))

  const results = []
  for (const attempt of attempts) {
    if (attempt.line) await appendFile(file, JSON.stringify(attempt.line) + '\n')
    results.push(attempt.record)
  }

  // No alias reached the scraper at all: it is down. Do not let an empty round
  // look like a successful scrape.
  if (!attempts.some(attempt => attempt.answered)) {
    const error = new Error('scraper unreachable')
    error.results = results
    throw error
  }
  return results
}
