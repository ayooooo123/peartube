import nodeFs from 'node:fs'
import nodeFsp from 'node:fs/promises'
import nodePath from 'node:path'
import { createHash } from 'node:crypto'
import { parseSeasonEpisode } from './matcher.js'

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi'])

export async function fingerprintFile (filePath, { fs = nodeFs } = {}) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(`sha256:${hash.digest('hex')}`))
  })
}

export async function scanLocalFile (filePath, { fs = nodeFs, fsp = nodeFsp, path = nodePath, fingerprint = fingerprintFile } = {}) {
  const stat = await fsp.stat(filePath)
  const base = path.basename(filePath)
  const withoutExt = base.replace(/\.[^.]+$/, '')
  const coords = parseSeasonEpisode(base)
  return {
    id: `local:${filePath}`,
    kind: 'local',
    path: filePath,
    filename: base,
    size: stat.size,
    title: withoutExt,
    seasonNumber: coords ? coords.seasonNumber : null,
    episodeNumber: coords ? coords.episodeNumber : null,
    embedded: coords,
    fingerprint: await fingerprint(filePath, { fs })
  }
}

export async function scanDirectory (dir, options = {}) {
  const fsp = options.fsp || nodeFsp
  const path = options.path || nodePath
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name))
    .sort()
  const out = []
  for (const file of files) out.push(await scanLocalFile(file, options))
  return out
}

export async function scanUrls (urls, { inspect } = {}) {
  if (typeof inspect !== 'function') throw new Error('scanUrls requires an inspect function')
  const out = []
  for (const url of urls) {
    const item = await inspect(url)
    if (item) out.push(urlSourceRecord(item, url))
  }
  return out
}

export async function scanPlaylist (url, { list } = {}) {
  if (typeof list !== 'function') throw new Error('scanPlaylist requires a list function')
  const profile = await list(url)
  const items = (profile && profile.items) || []
  return items.map((item) => urlSourceRecord(item, item.canonicalUrl))
}

function urlSourceRecord (item, url) {
  return {
    id: `url:${item.sourceProvider || 'unknown'}:${item.sourceVideoId || url}`,
    kind: 'url',
    url: url || item.canonicalUrl || null,
    sourceProvider: item.sourceProvider || null,
    sourceVideoId: item.sourceVideoId != null ? String(item.sourceVideoId) : null,
    title: item.title || null,
    airDate: item.sourcePublishedAt || null,
    duration: Number.isFinite(item.duration) ? item.duration : null,
    embedded: parseSeasonEpisode(item.title)
  }
}
