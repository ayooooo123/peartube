import b4a from 'b4a'
import { mediaFormat } from './protocol.js'

// What a music file says about itself, read from its own header without any network or decoder.
//
// Everything here is a claim by the file's encoder, and nothing else: a FLAC or MP3 can carry any album, artist
// and MusicBrainz id its creator typed. `parseTags` only reads, and only the tags a relay needs to name a track
// (`albumArtist`, `album`, `artist`, `title`, disc and track numbers, year) plus a MusicBrainz release id when the
// tags carry one. It never throws on malformed input: a block that does not parse ends the walk and yields what was
// read so far, since a half-tagged album is still better than none.
//
// Sizes: an ID3v2.4 tag length is synchsafe (7 bits per byte, four bytes), and v2.3's is a plain 32-bit integer.
// Reading either as the other is how tag readers report a 180-byte tag as 13 MB, so both are handled and the tag is
// bounded by the buffer it arrives in.

const MAX_TEXT = 300

// ID3's text frames use a leading encoding byte: 0 latin1, 1 UTF-16 with BOM, 2 big-endian UTF-16, 3 UTF-8.
function id3Text (raw) {
  if (!raw || raw.length < 1) return ''
  const enc = raw[0]
  const body = raw.subarray(1)
  let out
  if (enc === 0) out = b4a.toString(body, 'latin1')
  else if (enc === 1) out = utf16(body, true)
  else if (enc === 2) out = utf16(body, false)
  else if (enc === 3) out = b4a.toString(body, 'utf8')
  else return ''
  return out.replace(/\0+$/, '').replace(/\0[\s\S]*$/, '').slice(0, MAX_TEXT)
}

function utf16 (bytes, bom) {
  let start = 0
  let le = bom
  if (bom && bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) { le = true; start = 2 } else if (bytes[0] === 0xfe && bytes[1] === 0xff) { le = false; start = 2 }
  }
  let out = ''
  for (let i = start; i + 1 < bytes.length; i += 2) {
    const code = le ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]
    if (code === 0) break
    out += String.fromCharCode(code)
  }
  return out
}

// A numeric tag ("5", "05", "5/12") as an integer; a range keeps its first part, which is the number itself.
function num (v) {
  const m = /^\s*(\d{1,6})/.exec(String(v || ''))
  return m ? Number(m[1]) : null
}

// The year out of "1997", "1997-03-04", or a full timestamp; two-digit years are not guessed at.
function year (v) {
  const m = /\b(1[89]\d{2}|20\d{2})\b/.exec(String(v || ''))
  return m ? Number(m[1]) : null
}

// MusicBrainz ids appear in several spellings across taggers: ffmpeg writes `MUSICBRAINZ_ALBUMID` as a TXXX
// description, Picard writes `MusicBrainz Album Id`, and a file may carry only `MUSICBRAINZ_RELEASEGROUPID`.
// A release id is what a track id needs to resolve against, so it wins whatever order the tags are stored in. A
// release-group id is deliberately NOT accepted: it names every edition of an album at once, so using it as a
// release id splits one album into two whenever two rips carry different tag kinds.
// Hyphens are stripped because the channel's id shape is lowercase alphanumeric. Descriptions are compared with
// spaces and underscores removed, since each tagger spells the separator differently.
const MB_RELEASE_KEYS = new Set([
  'MUSICBRAINZALBUMID',
  'MUSICBRAINZRELEASEID',
  'MUSICBRAINZALBUMRELEASEID'
])
const MB_ID = /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}|[0-9a-f]{32})/i

function mbid (map) {
  for (const [key, value] of map) {
    if (!MB_RELEASE_KEYS.has(key.replace(/[\s_]+/g, ''))) continue
    const m = MB_ID.exec(value)
    if (m) return m[1].toLowerCase().replace(/-/g, '')
  }
  // A release-GROUP id names every edition of an album at once, so it is NOT a release id and must not be used as
  // one: a file carrying only `MUSICBRAINZ_RELEASEGROUPID` used to be stamped with that id, which made the same
  // album appear twice under two ids. No release id is the honest answer; the caller falls back to the album hash.
  return null
}

// The Vorbis comment structure FLAC, Ogg Vorbis and Opus share: a vendor string and a list of KEY=value, each with a
// little-endian 32-bit length. A body cut short (the read stopped inside it) keeps the entries read so far.
function vorbisComment (body, map) {
  let o = 0
  const rd = () => {
    if (o + 4 > body.length) return null
    const n = body[o] | (body[o + 1] << 8) | (body[o + 2] << 16) | (body[o + 3] << 24)
    o += 4
    if (n < 0 || o + n > body.length) return null
    const s = body.subarray(o, o + n)
    o += n
    return s
  }
  if (!rd()) return
  // The count is a bare little-endian 32-bit integer, not a length-prefixed string like the vendor.
  if (o + 4 > body.length) return
  const count = body[o] | (body[o + 1] << 8) | (body[o + 2] << 16) | (body[o + 3] << 24)
  o += 4
  for (let i = 0; i < count && i < 512; i++) {
    const kv = rd()
    if (!kv) break
    const text = b4a.toString(kv, 'utf8')
    const eq = text.indexOf('=')
    if (eq <= 0) continue
    map.set(text.slice(0, eq).toUpperCase(), text.slice(eq + 1).slice(0, MAX_TEXT))
  }
}

// FLAC: "fLaC" then metadata blocks, each a 4-byte header (last flag, 7-bit type, 24-bit length). Type 4 is the
// Vorbis comment.
function flacComments (buf) {
  const map = new Map()
  let p = 4
  let guard = 0
  while (p + 4 <= buf.length && guard++ < 64) {
    const head = buf[p]
    const last = (head & 0x80) !== 0
    const type = head & 0x7f
    const len = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]
    if (p + 4 + len > buf.length) break
    if (type === 4) {
      vorbisComment(buf.subarray(p + 4, p + 4 + len), map)
      break
    }
    p += 4 + len
    if (last) break
  }
  return map
}

// Ogg Vorbis and Opus: pages ("OggS", a 27-byte header, then a segment table). A packet is a run of segments ending in
// one shorter than 255 bytes, and may go on over the next page. The second packet is the comment header:
// "\x03vorbis" or "OpusTags", then the Vorbis comment structure. Cover art can make it longer than the bytes read, so a
// packet cut short is parsed as far as it goes.
function oggComments (buf) {
  const map = new Map()
  let segments = []
  let done = 0
  const comment = () => {
    const pk = b4a.concat(segments)
    if (b4a.toString(pk.subarray(0, 8), 'latin1') === 'OpusTags') vorbisComment(pk.subarray(8), map)
    else if (pk[0] === 3 && b4a.toString(pk.subarray(1, 7), 'latin1') === 'vorbis') vorbisComment(pk.subarray(7), map)
    return map
  }
  let p = 0
  let guard = 0
  while (p + 27 <= buf.length && guard++ < 1024 && b4a.toString(buf.subarray(p, p + 4), 'latin1') === 'OggS') {
    const count = buf[p + 26]
    let o = p + 27 + count
    if (o > buf.length) break
    for (let i = 0; i < count; i++) {
      const len = buf[p + 27 + i]
      if (o + len > buf.length) return done === 1 ? comment() : map
      segments.push(buf.subarray(o, o + len))
      o += len
      if (len === 255) continue
      if (++done === 2) return comment()
      segments = []
    }
    p = o
  }
  return done === 1 ? comment() : map
}

// ID3v2: a 10-byte header, then frames of a 4-character id and a size. v2.2 uses 3-character ids we do not read.
function id3Frames (buf) {
  const map = new Map()
  if (buf.length < 10 || b4a.toString(buf.subarray(0, 3), 'latin1') !== 'ID3') return map
  const major = buf[3]
  if (major !== 3 && major !== 4) return map
  const ss = b => b & 0x7f
  const size = major === 4
    ? (ss(buf[6]) << 21) | (ss(buf[7]) << 14) | (ss(buf[8]) << 7) | ss(buf[9])
    : ((buf[6] << 24) >>> 0) + (buf[7] << 16) + (buf[8] << 8) + buf[9]
  const end = Math.min(buf.length, 10 + size)
  let p = 10
  let guard = 0
  while (p + 10 <= end && guard++ < 256) {
    const id = b4a.toString(buf.subarray(p, p + 4), 'latin1')
    if (!/^[A-Z0-9]{4}$/.test(id)) break
    const fsz = major === 4
      ? (ss(buf[p + 4]) << 21) | (ss(buf[p + 5]) << 14) | (ss(buf[p + 6]) << 7) | ss(buf[p + 7])
      : ((buf[p + 4] << 24) >>> 0) + (buf[p + 5] << 16) + (buf[p + 6] << 8) + buf[p + 7]
    if (fsz < 0 || p + 10 + fsz > end) break
    const raw = buf.subarray(p + 10, p + 10 + fsz)
    if (id === 'TXXX') {
      // A user-defined text frame is "description\0value" in the frame's own encoding.
      const enc = raw[0]
      const zero = enc === 1 || enc === 2 ? 2 : 1
      let at = -1
      for (let i = 1; i + zero <= raw.length; i += zero) {
        if (zero === 2 ? raw[i] === 0 && raw[i + 1] === 0 : raw[i] === 0) { at = i; break }
      }
      if (at > 0) {
        const desc = id3Text(b4a.concat([b4a.from([enc]), raw.subarray(1, at)])).toUpperCase()
        const val = id3Text(b4a.concat([b4a.from([enc]), raw.subarray(at + zero)]))
        if (desc && val) map.set(desc, val)
      }
    } else if (id[0] === 'T') {
      map.set(id, id3Text(raw))
    }
    p += 10 + fsz
  }
  return map
}

// The tags a catalog needs, from either family of comment blocks, plus what the container is.
export function parseTags (buf) {
  if (!buf || buf.length < 4) return null
  const container = mediaFormat(buf)
  let map = null
  if (container === 'flac') map = flacComments(buf)
  else if (container === 'ogg') map = oggComments(buf)
  else if (container === 'mp3' || b4a.toString(buf.subarray(0, 3), 'latin1') === 'ID3') map = id3Frames(buf)
  if (!map || map.size === 0) return null
  // FLAC spells these in the comment; ID3 has dedicated frames (TPOS is a disc, TRCK a track), and both write them
  // as "n" or "n/total", which `num` keeps the first part of.
  const disc = num(map.get('DISCNUMBER') || map.get('DISCNO') || map.get('DISK') || map.get('TPOS'))
  const track = num(map.get('TRACKNUMBER') || map.get('TRACK') || map.get('TRCK'))
  return {
    container,
    albumArtist: map.get('ALBUMARTIST') || map.get('ALBUM ARTIST') || map.get('TPE2') || null,
    album: map.get('ALBUM') || map.get('TALB') || null,
    artist: map.get('ARTIST') || map.get('TPE1') || null,
    title: map.get('TITLE') || map.get('TIT2') || null,
    year: year(map.get('DATE') || map.get('YEAR') || map.get('TDRC') || map.get('TYER')),
    disc: disc && disc > 0 ? disc : null,
    track: track && track > 0 ? track : null,
    mbid: mbid(map),
    discogs: (() => {
      const v = map.get('DISCOGS_RELEASE_ID') || map.get('DISCOGSRELEASEID')
      const m = v && /(\d{1,12})/.exec(v)
      return m ? m[1] : null
    })()
  }
}

// The album identity two rips of the same album must share, and two different albums must not. Names are folded
// the way a person compares them: case, punctuation, spacing and accents carry no meaning here. Letters and digits
// of every script are kept: folding to a-z alone made every album named in Chinese, Japanese, Korean, Cyrillic or
// Greek the same album. The year is part of it because a self-titled album and its remaster are different
// releases; the disc and track count are not, because a lossless and a lossy rip of one album may drop the bonus
// disc and still be the same album.
export const albumKey = ({ albumArtist, album, year: y }) => {
  const fold = s => String(s || '').normalize('NFKD').toLowerCase().replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, '')
  return [fold(albumArtist), fold(album), y || ''].join('|')
}
