// Minimal valid MP4 builders shared by playback-profile and live tests.
// buildTestMp4: front-moov progressive MP4, one video trak (6 samples of
// 100 bytes, 1s apart at timescale 1000, sync samples 1 and 4).
// buildTestFmp4Init/Fragment: fragmented-MP4 pieces for live core tests.

function box(type, ...payloads) {
  const content = Buffer.concat(payloads.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))))
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + content.length, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, content])
}

function fullBoxPayload(version, ...payloads) {
  const head = Buffer.alloc(4)
  head.writeUInt8(version, 0)
  return Buffer.concat([head, ...payloads.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))])
}

function u32(...values) {
  const buf = Buffer.alloc(values.length * 4)
  values.forEach((v, i) => buf.writeUInt32BE(v, i * 4))
  return buf
}

/**
 * fMP4 init segment (ftyp + moov with mvex): one video trak, no samples in
 * the moov (they live in fragments).
 */
export function buildTestFmp4Init({ timescale = 1000 } = {}) {
  const ftyp = box('ftyp', Buffer.from('iso5'), u32(512), Buffer.from('iso5iso6'))
  const mdhd = box('mdhd', fullBoxPayload(0, u32(0, 0, timescale, 0), Buffer.alloc(4)))
  const hdlr = box('hdlr', fullBoxPayload(0, u32(0), Buffer.from('vide'), Buffer.alloc(12)))
  const stts = box('stts', fullBoxPayload(0, u32(0)))
  const stsc = box('stsc', fullBoxPayload(0, u32(0)))
  const stsz = box('stsz', fullBoxPayload(0, u32(0, 0)))
  const stco = box('stco', fullBoxPayload(0, u32(0)))
  const stbl = box('stbl', stts, stsc, stsz, stco)
  const trak = box('trak', box('mdia', mdhd, hdlr, box('minf', stbl)))
  const trex = box('trex', fullBoxPayload(0, u32(1, 1, 0, 0, 0)))
  const moov = box('moov', trak, box('mvex', trex))
  return Buffer.concat([ftyp, moov])
}

/**
 * fMP4 media fragment (moof + mdat) with a version-0 tfdt carrying
 * `decodeTime` in media timescale units.
 */
export function buildTestFmp4Fragment({ sequence = 1, decodeTime = 0, payloadBytes = 256 } = {}) {
  const mfhd = box('mfhd', fullBoxPayload(0, u32(sequence)))
  const tfhd = box('tfhd', fullBoxPayload(0, u32(1)))
  const tfdt = box('tfdt', fullBoxPayload(0, u32(decodeTime)))
  const traf = box('traf', tfhd, tfdt)
  const moof = box('moof', mfhd, traf)
  const mdat = box('mdat', Buffer.alloc(payloadBytes, sequence & 0xff))
  return Buffer.concat([moof, mdat])
}

export function buildTestMp4({ moovFirst = true } = {}) {
  const ftyp = box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso2'))
  const mdhd = box('mdhd', fullBoxPayload(0, u32(0, 0, 1000, 6000), Buffer.alloc(4)))
  const hdlr = box('hdlr', fullBoxPayload(0, u32(0), Buffer.from('vide'), Buffer.alloc(12)))
  const stts = box('stts', fullBoxPayload(0, u32(1, 6, 1000)))
  const stsc = box('stsc', fullBoxPayload(0, u32(1, 1, 3, 1)))
  const stsz = box('stsz', fullBoxPayload(0, u32(100, 6)))
  const stco = box('stco', fullBoxPayload(0, u32(2, 1000, 1300)))
  const stss = box('stss', fullBoxPayload(0, u32(2, 1, 4)))
  const stbl = box('stbl', stts, stsc, stsz, stco, stss)
  const trak = box('trak', box('mdia', mdhd, hdlr, box('minf', stbl)))
  const moov = box('moov', trak)
  const mdat = box('mdat', Buffer.alloc(2048))
  return moovFirst ? Buffer.concat([ftyp, moov, mdat]) : Buffer.concat([ftyp, mdat, moov])
}
