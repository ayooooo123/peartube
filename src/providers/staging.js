// What every source provider shares about the staging (import) folder: how an album folder is named and pinned, and
// how the files a relay put there itself are told from the owner's.
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

// A mirror told which album it fills pins its folder to that release in this dot file (skipped by the media walk);
// the importer then announces every file in the folder under it, whatever the files' tags say. Source bytes are never
// rewritten, so a mirrored file's sha256 is the hash of exactly what the source served. `{ release, title?, artist? }`:
// `artist` names the album's artist for files that carry no tags the importer reads (M4A).
export const ALBUM_PIN = '.peartube-album.json'
// `yt:` is the YouTube provider's namespace: an album saved from there never answers for an `mb:`/`discogs:`/`album:`
// release, so nobody asking for a release is handed a lossy copy.
export const RELEASE_ID = /^(mb:[0-9a-f]{32}|discogs:r\d{1,12}|album:[0-9a-f]{20}|yt:[0-9a-f]{20})$/
// The files this relay mirrored into an album folder, by name, in this dot file. Deleting an entry deletes its file
// only when the file is listed here (or sits in `<storage>/staging`, where nothing else writes): a file the owner put
// in the import folder is theirs, and only its announce goes.
export const MIRRORED_LIST = '.peartube-mirrored.json'

// `<dir>/<name>`, or `<stem> (2)<ext>`… when that name is taken: a mirror never overwrites a file already there.
export function freePath (dir, name) {
  const ext = extname(name)
  const stem = basename(name, ext)
  let candidate = join(dir, name)
  for (let n = 2; n < 1000; n++) {
    try { statSync(candidate) } catch { return candidate }
    candidate = join(dir, `${stem} (${n})${ext}`)
  }
  return candidate
}

export function safeSegment (raw, fallback) {
  const clean = String(raw || '')
    .replace(/[/\\:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/^[.@\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)
    .replace(/[.\s]+$/, '')
  return clean || fallback
}

export function formatAlbumDir ({ artist, album, year, fallbackTitle }) {
  if (artist && album) {
    return safeSegment(`${artist} - ${album}${year ? ` (${year})` : ''}`, 'Mirrored Album')
  }
  if (fallbackTitle) {
    const clean = String(fallbackTitle).replace(/\s*·\s*/g, ' - ').trim()
    return safeSegment(clean, 'Mirrored Album')
  }
  if (album) {
    return safeSegment(`${album}${year ? ` (${year})` : ''}`, 'Mirrored Album')
  }
  return 'Unknown Artist - Mirrored Album'
}

// Adds `names` to the folder's list of files this relay mirrored (MIRRORED_LIST), which deletion reads.
export function noteMirrored (dir, names) {
  const file = join(dir, MIRRORED_LIST)
  let list = []
  try { list = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  const next = [...new Set([...(Array.isArray(list) ? list : []), ...names])]
  writeFileSync(file, JSON.stringify(next) + '\n')
}
