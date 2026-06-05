import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import b4a from 'b4a'
import Corestore from 'corestore'
import HyperDB from 'hyperdb'

import { decode, encode } from '../lib/archive-schema.js'
import { archiveKey, readArchiveMapping, writeArchiveMapping } from '../lib/archive-writer.js'
import publicDbDefinition from '../src/channel/public-hyperdb-spec/hyperdb/index.js'

const fileHash = b4a.alloc(32, 1)
const coreKey = b4a.alloc(32, 2)
const secondCoreKey = b4a.alloc(32, 3)

function sampleMapping(overrides = {}) {
  return {
    fileHash,
    sourceId: 'youtube:dQw4w9WgXcQ',
    variants: [
      {
        resolution: '1080p',
        coreKey,
        startBlock: 7,
        endBlock: 42,
      },
    ],
    ...overrides,
  }
}

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function withHyperDb(fn) {
  const dir = makeTempDir('peartube-archive-writer-')
  const store = new Corestore(dir)
  let db = null

  try {
    await store.ready()
    const core = store.get({ name: `archive-writer-${Date.now()}-${Math.random()}` })
    await core.ready()
    db = HyperDB.bee(core, publicDbDefinition, {
      autoUpdate: true,
      writable: true,
      extension: false,
    })
    await db.ready()
    await fn(db)
  } finally {
    if (db) await db.close().catch(() => {})
    await store.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}

test('archive schema encodes compact file mappings and decodes canonical objects', () => {
  const mapping = sampleMapping()
  const encoded = encode(mapping)
  const decoded = decode(encoded)

  assert.ok(b4a.isBuffer(encoded))
  assert.equal(encoded.byteLength, 93)
  assert.deepEqual(decoded, mapping)
})

test('archive schema rejects malformed fixed hashes and ranges', () => {
  assert.throws(() => encode(sampleMapping({ fileHash: b4a.alloc(31) })), /fileHash must be exactly 32 bytes/)
  assert.throws(() => encode(sampleMapping({ variants: [{ resolution: '720p', coreKey, startBlock: 10, endBlock: 9 }] })), /endBlock must be >= startBlock/)
  assert.throws(() => decode(b4a.concat([encode(sampleMapping()), b4a.from([0])])), /trailing bytes/)
})

test('archive writer writes cenc records under the content-addressed archive key', async () => {
  await withHyperDb(async (db) => {
    const result = await writeArchiveMapping(db, fileHash, {
      sourceId: 'youtube:dQw4w9WgXcQ',
      variants: [{ resolution: '1080p', coreKey, startBlock: 7, endBlock: 42 }],
    })

    assert.equal(result.key, `/archives/${b4a.toString(fileHash, 'hex')}`)
    assert.deepEqual(result.mapping, sampleMapping())

    const raw = await db.engine.db.get(archiveKey(fileHash))
    assert.ok(raw?.value)
    assert.deepEqual(decode(raw.value), sampleMapping())
    assert.deepEqual(await readArchiveMapping(db, fileHash), sampleMapping())
  })
})

test('archive writer rejects pending HyperDB collection writes instead of committing caller state', async () => {
  await withHyperDb(async (db) => {
    await db.insert('@peartubePublic/metadata', { key: 'meta', name: 'Pending metadata' })

    await assert.rejects(
      writeArchiveMapping(db, fileHash, {
        sourceId: 'youtube:dQw4w9WgXcQ',
        variants: [{ resolution: '1080p', coreKey, startBlock: 7, endBlock: 42 }],
      }),
      /pending updates/
    )

    await db.flush()

    db.updates.mutating++
    try {
      await assert.rejects(
        writeArchiveMapping(db, fileHash, {
          sourceId: 'youtube:dQw4w9WgXcQ',
          variants: [{ resolution: '720p', coreKey, startBlock: 8, endBlock: 43 }],
        }),
        /pending updates/
      )
    } finally {
      db.updates.mutating--
    }

    const originalExclusiveTransaction = db.exclusiveTransaction.bind(db)
    db.exclusiveTransaction = async (...args) => {
      const tx = await originalExclusiveTransaction(...args)
      await db.insert('@peartubePublic/metadata', { key: 'late-meta', name: 'Late pending metadata' })
      return tx
    }
    try {
      await assert.rejects(
        writeArchiveMapping(db, fileHash, {
          sourceId: 'youtube:dQw4w9WgXcQ',
          variants: [{ resolution: '720p', coreKey, startBlock: 8, endBlock: 43 }],
        }),
        /pending updates/
      )
    } finally {
      db.exclusiveTransaction = originalExclusiveTransaction
    }

    await db.flush()

    await writeArchiveMapping(db, fileHash, {
      sourceId: 'youtube:dQw4w9WgXcQ',
      variants: [{ resolution: '1080p', coreKey, startBlock: 7, endBlock: 42 }],
    })

    const meta = await db.get('@peartubePublic/metadata', { key: 'meta' })
    const stored = await readArchiveMapping(db, fileHash)

    assert.equal(meta.name, 'Pending metadata')
    assert.deepEqual(stored, sampleMapping())
  })
})

test('archive writer serializes upserts and merges variants without dropping existing refs', async () => {
  await withHyperDb(async (db) => {
    await writeArchiveMapping(db, fileHash, {
      sourceId: 'youtube:dQw4w9WgXcQ',
      variants: [{ resolution: '1080p', coreKey, startBlock: 7, endBlock: 42 }],
    })

    await Promise.all([
      writeArchiveMapping(db, fileHash, {
        sourceId: 'youtube:dQw4w9WgXcQ',
        variants: [{ resolution: '720p', coreKey: secondCoreKey, startBlock: 43, endBlock: 70 }],
      }),
      writeArchiveMapping(db, fileHash, {
        sourceId: 'youtube:dQw4w9WgXcQ',
        variants: [{ resolution: '480p', coreKey, startBlock: 71, endBlock: 99 }],
      }),
    ])

    const stored = await readArchiveMapping(db, fileHash)
    assert.equal(stored.variants.length, 3)
    assert.deepEqual(stored.variants.map((variant) => variant.resolution), ['1080p', '720p', '480p'])
  })
})
