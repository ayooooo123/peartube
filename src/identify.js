import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import b4a from 'b4a'
import { send } from './art.js'
import { MEDIA_FILE } from './protocol.js'

export { posterUrl, backdropUrl } from './art.js'

// Licks a link before acquiring it so Master knows what is inside: a direct media file (parsed from its name) or a
// web page cracked open by `ubit` (YouTube, Vimeo, and 30+ extractors). Movie and episode names get Cinemeta
// suggestions; an accepted match becomes the `imdb:tt…` id MediaStorm searches for.
const NOISE = /\b(2160p|1080p|720p|576p|480p|4k|uhd|hdr10?|dv|bluray|blu-ray|bdrip|brrip|web-?dl|webrip|web|hdtv|dvdrip|remux|proper|repack|extended|unrated|x26[45]|h\.?26[45]|hevc|avc|av1|xvid|divx|aac|ac3|e?ac-?3|ddp?|dts|truehd|atmos|flac|opus|mp3)\b/i

export function parseName (raw) {
  let name = String(raw || '')
  try { name = decodeURIComponent(new URL(name).pathname.split('/').pop() || name) } catch {}
  const ext = (name.match(MEDIA_FILE) || [])[1]?.toLowerCase() || ''
  // A second media extension (`.mkv.mp4`) is part of the release name, not the title.
  const stem = name.replace(MEDIA_FILE, '').replace(MEDIA_FILE, '')
  const words = stem.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()
  const ep = words.match(/\bS(\d{1,2})\s?E(\d{1,3})\b/i) || words.match(/\b(\d{1,2})x(\d{2,3})\b/)
  const year = [...words.matchAll(/[([]?\b(19[2-9]\d|20[0-4]\d)\b[)\]]?/g)].pop()
  // A year or episode marks where the title ends; release tags only when neither is there ("Charlotte's Web 2006").
  const marks = [ep?.index, year?.index].filter(i => i != null && i > 0)
  const cuts = marks.length ? marks : [words.search(NOISE)].filter(i => i > 0)
  const pick = re => (words.match(re) || [])[1] || ''
  const title = words.slice(0, cuts.length ? Math.min(...cuts) : words.length).replace(/[[(-]+\s*$/, '').trim() || words
  return {
    title,
    year: year ? Number(year[1]) : null,
    season: ep ? Number(ep[1]) : null,
    episode: ep ? Number(ep[2]) : null,
    resolution: pick(/\b(2160p|1080p|720p|576p|480p|4k)\b/i).toLowerCase(),
    codec: pick(/\b(x26[45]|h\.?26[45]|hevc|avc|av1|vp9|xvid|divx)\b/i).toLowerCase(),
    audio: pick(/\b(e?ac-?3|ddp?5\.1|ddp?|dts(?:-hd)?|truehd|atmos|aac|flac|opus|mp3)\b/i).toLowerCase(),
    ext
  }
}


function ubitEnv (configDir) {
  if (!configDir) return undefined
  const out = {}
  for (const [k, v] of Object.entries(process.env)) if (v != null) out[k] = String(v)
  out.UBIT_CONFIG_DIR = configDir
  return out
}

function missing () {
  return Object.assign(new Error('Install ubit to add page links'), { status: 501, code: 'UBIT_MISSING' })
}

function tagStatus (msg) {
  if (/\bdrm\b/i.test(msg)) return { status: 451 }
  const m = msg.match(/\b(401|403|404|410|451)\b/)
  return m ? { status: Number(m[1]) } : {}
}

function ubitInfo (url, { configDir = '', timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try { child = spawn('ubit', ['info', url, '--json'], { env: ubitEnv(configDir), stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return reject(missing()) }
    const out = []
    const err = []
    let exited = null
    let ended = false
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
    timer.unref?.()
    const finish = () => {
      if (exited === null || !ended) return
      clearTimeout(timer)
      if (exited !== 0) {
        const raw = b4a.toString(b4a.concat(err), 'utf8').trim()
        const line = raw.split('\n').find(l => /^error:/i.test(l.trim())) || raw.split('\n')[0] || 'This page has no video ubit can read'
        const msg = line.replace(/^error:\s*/i, '').trim().slice(0, 200) || 'This page has no video ubit can read'
        return reject(Object.assign(new Error(msg), tagStatus(msg)))
      }
      let info
      try { info = JSON.parse(b4a.toString(b4a.concat(out), 'utf8')) } catch { return reject(new Error('ubit returned no metadata')) }
      if (info.isDRM) return reject(Object.assign(new Error('This video is DRM-protected'), { status: 451 }))
      resolve(info)
    }
    child.on('error', () => { clearTimeout(timer); reject(missing()) })
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))
    child.stdout.on('end', () => { ended = true; finish() })
    child.on('exit', code => { exited = code ?? 1; finish() })
  })
}

// Drains a page link through `ubit get` into a private scratch hole, muxing split DASH/HLS streams natively with live NDJSON progress.
export function downloadPage (pageUrl, outDir, { configDir = '', stallTimeout = 30_000, controller = null, onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    if (controller?.aborted) return reject(new Error('Cancelled'))
    let child
    const args = ['get', pageUrl, '--no-library', '--no-playlist', '--json', '-o', outDir]
    try { child = spawn('ubit', args, { env: ubitEnv(configDir), stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return reject(missing()) }
    const err = []
    let buf = ''
    let donePath = null
    let doneSize = null
    let eventErr = null
    let exited = null
    let ended = false
    let timedOut = false
    let timer = null
    const arm = ms => {
      clearTimeout(timer)
      timer = setTimeout(() => { timedOut = true; try { child.kill() } catch {} }, ms)
      timer.unref?.()
    }
    arm(Math.max(stallTimeout, 45_000))
    const onAbort = () => { try { child.kill() } catch {} }
    if (controller) controller.onabort = onAbort
    const parseLine = line => {
      const trimmed = line.trim()
      if (!trimmed) return
      let ev
      try { ev = JSON.parse(trimmed) } catch { return }
      if (ev.event === 'progress') {
        arm(stallTimeout)
        onProgress?.({ bytes: Number(ev.downloaded) || 0, total: Number(ev.total) > 0 ? Number(ev.total) : null })
      } else if (ev.event === 'process') {
        arm(Math.max(stallTimeout * 4, 120_000))
      } else if (ev.event === 'done') {
        donePath = typeof ev.path === 'string' ? ev.path : null
        doneSize = Number(ev.size)
      } else if (ev.event === 'error' && ev.error) {
        eventErr = String(ev.error)
      } else {
        arm(stallTimeout)
      }
    }
    const finish = () => {
      if (exited === null || !ended) return
      clearTimeout(timer)
      if (controller?.onabort === onAbort) controller.onabort = null
      if (controller?.aborted) return reject(new Error('Cancelled'))
      if (timedOut) return reject(new Error('Source stalled'))
      if (exited !== 0 || !donePath) {
        const raw = eventErr || b4a.toString(b4a.concat(err), 'utf8').trim()
        const line = raw.split('\n').find(l => /^error:/i.test(l.trim())) || raw.split('\n')[0] || 'ubit failed to download this page'
        const msg = line.replace(/^error:\s*/i, '').trim().slice(0, 200) || 'ubit failed to download this page'
        return reject(Object.assign(new Error(msg), tagStatus(msg)))
      }
      resolve({ path: donePath, size: Number.isSafeInteger(doneSize) && doneSize >= 0 ? doneSize : null })
    }
    child.on('error', () => {
      clearTimeout(timer)
      if (controller?.onabort === onAbort) controller.onabort = null
      reject(missing())
    })
    child.stdout.on('data', c => {
      buf += b4a.toString(c, 'utf8')
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        parseLine(line)
      }
    })
    child.stderr.on('data', c => { arm(stallTimeout); err.push(c) })
    child.stdout.on('end', () => { if (buf) { parseLine(buf); buf = '' } ended = true; finish() })
    child.on('exit', code => { exited = code ?? 1; finish() })
  })
}

// A debrid/CDN link hides the release name in ?filename= or content-disposition while its path is an opaque
// id (`/dld/<uuid>`), so the path alone would read a 60 GB MKV as a webpage.
function fileName (raw, headers = {}) {
  const u = new URL(raw)
  const cd = String(headers['content-disposition'] || '')
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i)
  let named = null
  try { named = star ? decodeURIComponent(star[1]) : null } catch {}
  const names = [u.searchParams.get('filename'), named, (cd.match(/filename="([^"]+)"/i) || [])[1]]
  const fromPath = decodeURIComponent(u.pathname.split('/').pop() || '')
  return names.find(n => n && MEDIA_FILE.test(n)) || fromPath
}

async function probe (url, opts) {
  let head = null
  try { head = await send(url, { method: 'HEAD' }) } catch {}
  const type = String(head?.headers['content-type'] || '').toLowerCase()
  const finalUrl = head?.url || url
  const name = fileName(finalUrl, head?.headers)
  const looksMedia = type.startsWith('video/') || type.includes('matroska') || (MEDIA_FILE.test(name) && !type.startsWith('text/'))
  if (head && head.status < 400 && looksMedia) {
    return { kind: 'file', name, size: Number(head.headers['content-length']) || null, contentType: type || null }
  }
  if (head && head.status >= 400 && MEDIA_FILE.test(name)) throw new Error(`The link answered ${head.status}`)
  const info = await ubitInfo(url, opts)
  const formats = Array.isArray(info.formats) ? info.formats : []
  const height = Math.max(0, ...formats.map(f => Number(f.height) || 0)) || Number(info.height) || 0
  const size = Number(info.filesize) || Math.max(0, ...formats.map(f => Number(f.filesize) || 0)) || null
  return {
    kind: 'page',
    name: info.title || '',
    site: info.site || '',
    uploader: info.author || info.uploader || '',
    duration: Number(info.duration) || null,
    thumbnail: info.thumbnail || null,
    size,
    resolution: height ? height + 'p' : '',
    pageId: String(info.webpageURL || url)
  }
}

export async function cinemetaSearch (base, { title, year, season }) {
  if (!base || !title) return []
  const type = season ? 'series' : 'movie'
  const res = await send(`${base}/catalog/${type}/top/search=${encodeURIComponent(title)}.json`, { timeoutMs: 8000 })
  if (res.status !== 200) return []
  let metas = []
  try { metas = JSON.parse(res.body).metas || [] } catch {}
  const out = []
  for (const m of metas) {
    const imdb = String(m.imdb_id || m.id || '')
    if (!/^tt\d{5,10}$/.test(imdb)) continue
    const y = Number(String(m.releaseInfo || m.year || '').slice(0, 4)) || null
    out.push({ imdb, type, name: String(m.name || ''), year: y, poster: typeof m.poster === 'string' ? m.poster : null })
  }
  // Only names sharing at least half their words with the parsed title; exact title first, then same year,
  // then Cinemeta's own order (a stable sort keeps it).
  const want = norm(title)
  const words = new Set(want.split(' '))
  const related = c => {
    const theirs = norm(c.name).split(' ')
    return theirs.filter(w => words.has(w)).length / Math.max(theirs.length, words.size) >= 0.5
  }
  const score = c => (norm(c.name) === want ? 2 : 0) + (year && c.year === year ? 1 : 0)
  return out.filter(related).sort((a, b) => score(b) - score(a)).slice(0, 6)
}

const norm = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').replace(/^(the|a|an) /, '').trim()

// A suggestion is taken without asking only when the title matches exactly and the year (if known) agrees.
const strong = (c, parsed) => norm(c.name) === norm(parsed.title) && (c.type === 'series' || !parsed.year || c.year === parsed.year)

// The id and title an entry is announced under for a chosen candidate, in the shapes MediaStorm searches for.
export function candidateEntry (c, parsed) {
  if (c.type === 'series' && parsed.season != null && parsed.episode != null) {
    const se = `s${String(parsed.season).padStart(2, '0')}e${String(parsed.episode).padStart(2, '0')}`
    return { id: `imdb:${c.imdb}:${se}`, title: `${c.name} ${se.toUpperCase()}` }
  }
  return { id: `imdb:${c.imdb}`, title: c.year ? `${c.name} ${c.year}` : c.name }
}

export async function identify (url, { cinemetaUrl = '', configDir = '' } = {}) {
  const link = await probe(url, { configDir })
  const parsed = parseName(link.name)
  if (link.resolution) parsed.resolution = link.resolution
  // Page titles are free text; only ones that read like a release (a year or an episode) get movie suggestions.
  const lookup = link.kind === 'file' || parsed.year || parsed.season != null
  const candidates = lookup ? await cinemetaSearch(cinemetaUrl, parsed).catch(() => []) : []
  const se = parsed.season != null ? ` S${String(parsed.season).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')}` : ''
  const plain = {
    id: 'clip:' + createHash('sha256').update(link.kind === 'page' ? link.pageId : url).digest('hex').slice(0, 16),
    title: (link.kind === 'page' ? link.name : parsed.title + se) || parsed.title
  }
  const { pageId: _p, ...shown } = link
  const list = candidates.map(c => ({ ...c, ...candidateEntry(c, parsed) }))
  return {
    link: shown,
    parsed,
    candidates: list,
    match: list.find(c => strong(c, parsed))?.id || null,
    plain
  }
}

