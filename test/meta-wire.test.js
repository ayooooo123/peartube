import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import b4a from 'b4a'
import c from 'compact-encoding'
import * as protocol from '../src/protocol.js'

const VECTORS_URL = new URL('../spec/meta-vectors.json', import.meta.url)

async function loadWire () {
  let wire = null
  try { wire = await import('../src/meta-wire.js') } catch (err) { void err }
  assert.ok(wire, 'src/meta-wire.js must exist')
  return wire
}

function loadVectors () {
  let raw = null
  try { raw = readFileSync(VECTORS_URL, 'utf8') } catch (err) { void err }
  assert.ok(raw, 'spec/meta-vectors.json must exist')
  return JSON.parse(raw)
}

function cardToJson (card) {
  return { ...card, thumbHash: b4a.toString(card.thumbHash, 'base64') }
}

function bucketToJson (bucket) {
  return {
    ...bucket,
    hits: bucket.hits.map(h => ({ ...h, thumbHash: b4a.toString(h.thumbHash, 'base64') }))
  }
}

function encodeRawFields (bytesList) {
  return b4a.concat(bytesList)
}

function encUtf8 (s) {
  return c.encode(c.utf8, s)
}

test('peartube://meta URI formatting, parsing, normalization, and validation', () => {
  assert.equal(typeof protocol.formatMetaUri, 'function', 'protocol.formatMetaUri must exist')
  const vectors = loadVectors()

  for (const tc of vectors.uri) {
    assert.equal(protocol.formatMetaUri(tc.key, tc.alias), tc.formatted)
    assert.deepEqual(protocol.parseUri(tc.input || tc.formatted), tc.parsed)
  }

  const upperKey = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789'
  const lowerKey = upperKey.toLowerCase()
  assert.equal(protocol.formatMetaUri(upperKey), `peartube://meta/${lowerKey}`)
  assert.deepEqual(protocol.parseUri(`peartube://meta/${upperKey}`), { action: 'meta', key: lowerKey, alias: '' })
  assert.deepEqual(
    protocol.parseUri(`peartube://meta/${upperKey}?alias=Catalog+One`),
    { action: 'meta', key: lowerKey, alias: 'Catalog One' }
  )

  for (const bad of ['', 'abc', 'z'.repeat(64), `${lowerKey}00`, lowerKey.slice(0, 63)]) {
    assert.throws(() => protocol.formatMetaUri(bad), /64 hex/)
    if (bad) assert.throws(() => protocol.parseUri(`peartube://meta/${bad}`), /64 hex/)
  }
})

test('spec/meta-vectors.json constants and deterministic helper vectors match', async () => {
  const wire = await loadWire()
  const vectors = loadVectors()

  assert.equal(wire.META_WIRE_VERSION, vectors.version)
  assert.equal(wire.ART_BLOB_BLOCK_SIZE, vectors.artBlobBlockSize)
  assert.equal(wire.META_SHARDS_PER_WRITER, vectors.shardsPerWriter)

  for (const tc of vectors.helpers.canonicalMetaId) {
    assert.equal(wire.canonicalMetaId(tc.input), tc.expected, `canonicalMetaId(${JSON.stringify(tc.input)})`)
  }
  assert.equal(wire.canonicalMetaId(null), null)
  assert.equal(wire.canonicalMetaId(12345), null)

  for (const tc of vectors.helpers.foldPrefix3) {
    assert.equal(wire.foldText(tc.input), tc.folded, `foldText(${JSON.stringify(tc.input)})`)
    assert.equal(wire.foldPrefix3(tc.input), tc.prefix3, `foldPrefix3(${JSON.stringify(tc.input)})`)
  }

  for (const tc of vectors.helpers.metaDiscoveryTopic) {
    const fromHex = b4a.toString(wire.metaDiscoveryTopic(tc.keyHex), 'hex')
    const fromBuf = b4a.toString(wire.metaDiscoveryTopic(b4a.from(tc.keyHex, 'hex')), 'hex')
    assert.equal(fromHex, tc.topicHex)
    assert.equal(fromBuf, tc.topicHex)
  }
  assert.throws(() => wire.metaDiscoveryTopic('00'.repeat(32) + 'zz'), /64 hex/)
  assert.throws(() => wire.metaDiscoveryTopic(b4a.alloc(31)), /64 hex/)

  for (const tc of vectors.helpers.artHash) {
    const bytes = b4a.from(tc.inputHex, 'hex')
    const hashHex = wire.artHashHex(bytes)
    assert.equal(hashHex, tc.hashHex)
    assert.equal(wire.shardIndexForHash(hashHex), tc.shardIdx)
    assert.equal(wire.shardIndexForHash(b4a.from(hashHex, 'hex')), tc.shardIdx)
  }
  assert.throws(() => wire.artHash(b4a.alloc(0)), /1\.\./)
  assert.throws(() => wire.artHash(b4a.alloc(wire.MAX_ART_BYTES + 1)), /1\.\./)
})

test('every golden record vector encodes to exact hex and decodes back cleanly', async () => {
  const wire = await loadWire()
  const { records } = loadVectors()

  const checks = [
    ['artPtr', wire.encodeArtPtr, wire.decodeArtPtr, v => v],
    ['shardEntry', wire.encodeShardEntry, wire.decodeShardEntry, v => v],
    ['searchSnapshot', wire.encodeSearchSnapshot, wire.decodeSearchSnapshot, v => v],
    ['cardMovie', wire.encodeCard, wire.decodeCard, cardToJson],
    ['cardAlbum', wire.encodeCard, wire.decodeCard, cardToJson],
    ['detail', wire.encodeDetail, wire.decodeDetail, v => v],
    ['list', wire.encodeList, wire.decodeList, v => v],
    ['indexBucket', wire.encodeIndexBucket, wire.decodeIndexBucket, bucketToJson]
  ]

  for (const [name, encode, decode, toJson] of checks) {
    const vec = records[name]
    assert.ok(vec, `missing golden vector records.${name}`)
    const encoded = encode(vec.value)
    assert.equal(b4a.toString(encoded, 'hex'), vec.hex, `records.${name} hex mismatch`)
    const decoded = decode(b4a.from(vec.hex, 'hex'))
    assert.deepEqual(toJson(decoded), vec.value, `records.${name} decode mismatch`)
    if (name === 'cardMovie') {
      assert.equal(decoded.thumbHash.byteLength, 25)
      assert.equal(b4a.toString(decoded.thumbHash, 'hex'), vec.thumbHashHex)
    }
    if (name === 'cardAlbum') {
      assert.equal(decoded.thumbHash.byteLength, 0)
      assert.equal(decoded.backdropHash, '')
    }
  }
})

test('all 9 golden meta op vectors encode to exact hex and decode back cleanly', async () => {
  const wire = await loadWire()
  const { ops, records } = loadVectors()

  const expectedTypes = ['init', 'grant', 'revoke', 'putShard', 'putArt', 'putCard', 'putDetail', 'setSnapshot', 'remove']
  for (const name of expectedTypes) {
    const vec = ops[name]
    assert.ok(vec, `missing golden vector ops.${name}`)
    const encoded = wire.encodeMetaOp(vec.op)
    assert.equal(b4a.toString(encoded, 'hex'), vec.hex, `ops.${name} hex mismatch`)
    const decoded = wire.decodeMetaOp(b4a.from(vec.hex, 'hex'))
    assert.ok(decoded, `ops.${name} must decode`)
    assert.equal(decoded.type, name)

    if (name === 'init' || name === 'grant' || name === 'revoke' || name === 'remove') {
      assert.deepEqual(decoded, vec.op)
    } else if (name === 'putShard') {
      assert.deepEqual(decoded.shard, vec.op.shard)
      assert.equal(b4a.toString(decoded.raw, 'hex'), records.shardEntry.hex)
    } else if (name === 'putArt') {
      assert.equal(decoded.hash, vec.op.hash)
      assert.deepEqual(decoded.ptr, vec.op.ptr)
      assert.equal(b4a.toString(decoded.raw, 'hex'), records.artPtr.hex)
    } else if (name === 'putCard') {
      assert.deepEqual(cardToJson(decoded.card), vec.op.card)
      assert.equal(b4a.toString(decoded.raw, 'hex'), records.cardMovie.hex)
    } else if (name === 'putDetail') {
      assert.deepEqual(decoded.detail, vec.op.detail)
      assert.equal(b4a.toString(decoded.raw, 'hex'), records.detail.hex)
    } else if (name === 'setSnapshot') {
      assert.deepEqual(decoded.snapshot, vec.op.snapshot)
      assert.equal(b4a.toString(decoded.raw, 'hex'), records.searchSnapshot.hex)
    }
  }
})

test('record codecs strictly reject wrong versions, truncation, trailing bytes, and invalid enums', async () => {
  const wire = await loadWire()
  const { records } = loadVectors()

  const codecs = [
    ['artPtr', wire.decodeArtPtr, records.artPtr.hex],
    ['shardEntry', wire.decodeShardEntry, records.shardEntry.hex],
    ['searchSnapshot', wire.decodeSearchSnapshot, records.searchSnapshot.hex],
    ['cardMovie', wire.decodeCard, records.cardMovie.hex],
    ['detail', wire.decodeDetail, records.detail.hex],
    ['list', wire.decodeList, records.list.hex],
    ['indexBucket', wire.decodeIndexBucket, records.indexBucket.hex]
  ]

  for (const [name, decode, hex] of codecs) {
    const valid = b4a.from(hex, 'hex')

    for (const badVer of [0x00, 0x02, 0xff]) {
      const mut = b4a.from(valid)
      mut[0] = badVer
      assert.throws(() => decode(mut), /version/, `${name} version 0x${badVer.toString(16)}`)
    }

    assert.throws(() => decode(b4a.alloc(0)), /Truncated/, `${name} empty`)
    assert.throws(() => decode(b4a.from([0x01])), /Truncated/, `${name} 1-byte`)
    assert.throws(() => decode(valid.subarray(0, valid.byteLength - 1)), `${name} truncated by 1`)
    assert.throws(() => decode(valid.subarray(0, Math.max(2, Math.floor(valid.byteLength / 2)))), `${name} half`)
    assert.throws(() => decode(b4a.concat([valid, b4a.from([0x00])])), /Trailing/, `${name} trailing byte`)
  }

  // Invalid mime codes in ArtBlobPtr (last byte of artPtr is mime:u8).
  const artBuf = b4a.from(records.artPtr.hex, 'hex')
  for (const badMime of [0, 4, 255]) {
    const mut = b4a.from(artBuf)
    mut[mut.byteLength - 1] = badMime
    assert.throws(() => wire.decodeArtPtr(mut), /mime/)
  }
  assert.throws(() => wire.encodeArtPtr({ ...records.artPtr.value, mime: 'image/gif' }), /mime/)

  // Invalid kind codes in MetaCard, MetaList, MetaIndexBucket.
  const listBuf = b4a.from(records.list.hex, 'hex')
  const bucketBuf = b4a.from(records.indexBucket.hex, 'hex')
  for (const badKind of [0, 5, 255]) {
    const ml = b4a.from(listBuf)
    ml[1] = badKind
    assert.throws(() => wire.decodeList(ml), /kind/)

    const mb = b4a.from(bucketBuf)
    mb[1] = badKind
    assert.throws(() => wire.decodeIndexBucket(mb), /kind/)
  }

  const cardWithBadKind = encodeRawFields([
    b4a.from([0x01]),
    encUtf8('imdb:tt0133093'),
    b4a.from([0x09])
  ])
  assert.throws(() => wire.decodeCard(cardWithBadKind), /kind/)
})

test('record codecs strictly reject oversized varints, non-canonical IDs, and domain bounds', async () => {
  const wire = await loadWire()
  const { records } = loadVectors()

  // Oversized genres count varint: 0xfe 0xff 0xff 0x00 0x00 = 65535 -> throws before allocating.
  const hugeGenresCard = encodeRawFields([
    b4a.from([0x01]),
    encUtf8('imdb:tt0133093'),
    b4a.from([0x01]),
    encUtf8('The Matrix'),
    encUtf8(''),
    b4a.from([0xcf, 0x07]),
    b4a.from([0x57, 0x00]),
    b4a.from([0xfe, 0xff, 0xff, 0x00, 0x00])
  ])
  assert.throws(() => wire.decodeCard(hugeGenresCard), /exceeds limit 16/)

  // Oversized list ids count varint (65535 > 256).
  const hugeList = encodeRawFields([
    b4a.from([0x01, 0x01]),
    encUtf8('popular'),
    encUtf8('Popular'),
    b4a.from([0xfe, 0xff, 0xff, 0x00, 0x00])
  ])
  assert.throws(() => wire.decodeList(hugeList), /exceeds limit 256/)

  // Oversized indexBucket hits count varint (65535 > 64).
  const hugeBucket = encodeRawFields([
    b4a.from([0x01, 0x01]),
    encUtf8('mat'),
    b4a.from([0xfe, 0xff, 0xff, 0x00, 0x00])
  ])
  assert.throws(() => wire.decodeIndexBucket(hugeBucket), /exceeds limit 64/)

  // Non-canonical IDs on the wire (raw invalid id, missing prefix, and uppercase).
  for (const badId of ['bad:id', 'tt0133093', 'IMDB:TT0133093']) {
    const rawCard = encodeRawFields([b4a.from([0x01]), encUtf8(badId), b4a.from([0x01])])
    assert.throws(() => wire.decodeCard(rawCard), /Non-canonical/)

    const rawDetail = encodeRawFields([b4a.from([0x01]), encUtf8(badId)])
    assert.throws(() => wire.decodeDetail(rawDetail), /Non-canonical/)

    const rawList = encodeRawFields([
      b4a.from([0x01, 0x01]),
      encUtf8('popular'),
      encUtf8('Popular'),
      b4a.from([0x01]),
      encUtf8(badId),
      b4a.from([0x00])
    ])
    assert.throws(() => wire.decodeList(rawList), /Non-canonical/)
  }

  // Zero blockLength / byteLength in ArtBlobPtr (encode and raw wire decode).
  assert.throws(() => wire.encodeArtPtr({ ...records.artPtr.value, blockLength: 0 }), /non-zero/)
  assert.throws(() => wire.encodeArtPtr({ ...records.artPtr.value, byteLength: 0 }), /non-zero/)

  const zeroBlockPtr = encodeRawFields([
    b4a.from([0x01, 0x07, 0x00, 0x2a]),
    b4a.from([0x00, 0x00, 0x00, 0x00]),
    b4a.from([0x00, 0x04, 0x00, 0x00]),
    b4a.from([0x00, 0x40, 0x01, 0x00]),
    b4a.from([0x58, 0x02, 0x84, 0x03, 0x01])
  ])
  assert.throws(() => wire.decodeArtPtr(zeroBlockPtr), /non-zero/)

  const zeroBytePtr = encodeRawFields([
    b4a.from([0x01, 0x07, 0x00, 0x2a]),
    b4a.from([0x02, 0x00, 0x00, 0x00]),
    b4a.from([0x00, 0x04, 0x00, 0x00]),
    b4a.from([0x00, 0x00, 0x00, 0x00]),
    b4a.from([0x58, 0x02, 0x84, 0x03, 0x01])
  ])
  assert.throws(() => wire.decodeArtPtr(zeroBytePtr), /non-zero/)

  // Invalid shardIdx >= 8 in MetaShardEntry (encode and raw wire decode).
  assert.throws(() => wire.encodeShardEntry({ ...records.shardEntry.value, shardIdx: 8 }), /shardIdx/)
  const shardBuf = b4a.from(records.shardEntry.hex, 'hex')
  for (const badIdx of [8, 9, 255]) {
    const mut = b4a.from(shardBuf)
    mut[1 + 2 + 32] = badIdx
    assert.throws(() => wire.decodeShardEntry(mut), /shardIdx/)
  }

  // Invalid thumbHash > 32 bytes (encode and raw wire decode).
  assert.throws(() => wire.encodeCard({ ...records.cardMovie.value, thumbHash: b4a.alloc(33, 1) }), /thumbHash/)
  const card33Thumb = encodeRawFields([
    b4a.from([0x01]),
    encUtf8('imdb:tt0133093'),
    b4a.from([0x01]),
    encUtf8('The Matrix'),
    encUtf8(''),
    b4a.from([0xcf, 0x07, 0x57, 0x00, 0x00, 0x88, 0x00]),
    b4a.from([33]),
    b4a.alloc(33, 0xaa),
    b4a.from([0x00, 0x00, 0x00])
  ])
  assert.throws(() => wire.decodeCard(card33Thumb), /thumbHash/)

  // Invalid optional hash flag (2 instead of 0 or 1).
  const badOptFlagCard = encodeRawFields([
    b4a.from([0x01]),
    encUtf8('imdb:tt0133093'),
    b4a.from([0x01]),
    encUtf8('The Matrix'),
    encUtf8(''),
    b4a.from([0xcf, 0x07, 0x57, 0x00, 0x00, 0x88, 0x00, 0x00]),
    b4a.from([0x02])
  ])
  assert.throws(() => wire.decodeCard(badOptFlagCard), /optional hash flag/)
})

test('decodeMetaOp returns null and never throws on malformed or hostile inputs', async () => {
  const wire = await loadWire()
  const { ops } = loadVectors()

  for (const nonBuf of [null, undefined, '', '0101', 42, {}, []]) {
    assert.equal(wire.decodeMetaOp(nonBuf), null)
  }
  assert.equal(wire.decodeMetaOp(b4a.alloc(0)), null)
  assert.equal(wire.decodeMetaOp(b4a.from([0x01])), null)

  for (const [name, vec] of Object.entries(ops)) {
    const valid = b4a.from(vec.hex, 'hex')

    // Wrong version byte.
    for (const badVer of [0x00, 0x02, 0xff]) {
      const mut = b4a.from(valid)
      mut[0] = badVer
      assert.equal(wire.decodeMetaOp(mut), null, `${name} wrong version 0x${badVer.toString(16)}`)
    }

    // Truncated buffer.
    assert.equal(wire.decodeMetaOp(valid.subarray(0, valid.byteLength - 1)), null, `${name} truncated -1`)
    assert.equal(wire.decodeMetaOp(valid.subarray(0, 2)), null, `${name} header only`)

    // Trailing garbage byte.
    assert.equal(wire.decodeMetaOp(b4a.concat([valid, b4a.from([0x00])])), null, `${name} trailing byte`)
  }

  // Unknown op codes.
  for (const badOp of [0x00, 0x0a, 0x7f, 0xff]) {
    assert.equal(wire.decodeMetaOp(b4a.from([0x01, badOp, 0x00])), null)
  }

  // Invalid grant role.
  const badRoleGrant = encodeRawFields([
    b4a.from([0x01, 0x02]),
    b4a.alloc(32, 0x11),
    encUtf8('superadmin'),
    encUtf8('Bad'),
    b4a.from([0x00])
  ])
  assert.equal(wire.decodeMetaOp(badRoleGrant), null)

  // Empty and oversized remove keys.
  assert.equal(wire.decodeMetaOp(encodeRawFields([b4a.from([0x01, 0x09]), encUtf8('')])), null)
  assert.equal(wire.decodeMetaOp(encodeRawFields([b4a.from([0x01, 0x09]), encUtf8('k'.repeat(257))])), null)

  // Corrupted inner record inside putCard (version 0x99).
  const badInnerCard = encodeRawFields([
    b4a.from([0x01, 0x06]),
    c.encode(c.buffer, b4a.from([0x99, 0x00, 0x00]))
  ])
  assert.equal(wire.decodeMetaOp(badInnerCard), null)
})
