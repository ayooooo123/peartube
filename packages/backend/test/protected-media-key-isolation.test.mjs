import test from 'brittle'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import { getEncoding } from '@peartube/spec/schema'

import { PUBLIC_DRM_PROPERTY_NAMES, isSecretShapedPropertyName } from '../src/access/protected-rendition.js'
import { createArchivePledge } from '../src/archive/pledge.js'
import { createArchiveStore } from '../src/archive/store.js'
import {
  createAssetManifestStore,
  createAssetSession,
  createPublicationManifest,
  createRenditionDescriptor,
  encodePublicationManifest,
} from '../src/assets/index.js'
import { createMediaGraphApi } from '../src/api/media-graph.js'
import { createEntityReference, createMediaClaim, createMediaGraphStore, encodeMediaClaimEnvelope } from '../src/media-graph/index.js'
import { encodePeerFrame } from '../src/network/frame.js'
import { deriveAssetTopic } from '../src/network/topics.js'
import { logger, setLogLevel } from '../src/logger.js'

/**
 * The protected-media key boundary, verified rather than asserted.
 *
 * ONE canary stands in for every value that must never leave the platform CDM
 * or the app's own vault: the content key, the license response, and the
 * provider bearer token. The backend, HRPC, Hypercore/Hyperbee state, archive
 * evidence and relay-visible state handle only signed PUBLIC descriptors and
 * opaque ciphertext, so there is nowhere for this string to be. This test drives
 * a protected publication end to end and then proves it is absent from every
 * boundary the flow actually touched.
 *
 * Two halves, and both are needed:
 *   - by construction: the descriptor constructor REFUSES key-material-shaped
 *     input, so the canary cannot enter a signed manifest even by mistake, and
 *     the refusal itself does not quote what it refused;
 *   - by sweep: after the legitimate flow, every captured boundary is scanned.
 *
 * The sweep is mutation-checked in-file: `the canary sweep detects a planted
 * canary at every boundary it claims to cover` plants the marker in one capture
 * of each kind and requires the detector to fire. A sweep that cannot fail is
 * not evidence.
 */

const CANARY = 'PEARTUBE-DEV-CANARY-CONTENT-KEY-4f8a1c0b9e2d7364'

// The shapes a careless implementation would actually produce: the marker
// itself, base64 as a license blob would carry it, and hex as key material is
// usually written. All ASCII, so `latin1` compares byte-exactly at any offset.
const NEEDLES = Object.freeze([
  CANARY,
  CANARY.toLowerCase(),
  b4a.toString(b4a.from(CANARY, 'utf8'), 'base64'),
  b4a.toString(b4a.from(CANARY, 'utf8'), 'hex'),
])

const FIXED_NOW = 1_700_000_000_000
const publisher = crypto.keyPair(b4a.alloc(32, 1))
const archivist = crypto.keyPair(b4a.alloc(32, 2))

// The CDM/provider side of the boundary, and the only place the canary lives.
// A real platform CDM builds the challenge, receives the license, and keeps the
// decrypted key; nothing in this object is ever handed to backend code.
function providerCdm() {
  const contentKey = b4a.from(CANARY, 'utf8')
  return {
    contentKey,
    licenseResponse: `{"key":"${b4a.toString(contentKey, 'base64')}"}`,
    // Ciphertext is derived FROM the key and is public: peers, relays and
    // archivists cache exactly these bytes without any entitlement.
    encrypt(plaintext) {
      const stream = crypto.data(contentKey)
      const out = b4a.alloc(plaintext.byteLength)
      for (let i = 0; i < plaintext.byteLength; i++) out[i] = plaintext[i] ^ stream[i % stream.byteLength]
      return out
    },
  }
}

/**
 * Render any value as one searchable string.
 *
 * Deliberately NOT `JSON.stringify`: `Buffer.prototype.toJSON` turns bytes into
 * `{type:'Buffer',data:[…]}` before a replacer can see them, so a marker inside
 * a nested buffer would survive the sweep as a list of integers. Walking the
 * graph by hand renders every byte run twice - hex for a raw marker, latin1 for
 * one already hex- or base64-encoded - and keeps property NAMES in the haystack
 * too, since a field called `contentKey` is itself the finding.
 */
function renderValue(value, depth = 0, seen = new Set()) {
  if (depth > 12) return '[depth]'
  if (value === null || value === undefined) return String(value)
  if (b4a.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = b4a.from(value)
    return `${b4a.toString(bytes, 'hex')}|${b4a.toString(bytes, 'latin1')}`
  }
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack || ''}`
  if (typeof value === 'function') return `[function ${value.name}]`
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  const join = parts => parts.join('\u0001')
  if (Array.isArray(value)) return join(value.map(item => renderValue(item, depth + 1, seen)))
  if (value instanceof Map) return join([...value].map(([key, item]) => `${renderValue(key, depth + 1, seen)}=${renderValue(item, depth + 1, seen)}`))
  if (value instanceof Set) return join([...value].map(item => renderValue(item, depth + 1, seen)))
  return join(Object.entries(value).map(([key, item]) => `${key}=${renderValue(item, depth + 1, seen)}`))
}

/**
 * A boundary recorder. Everything the flow can persist, encode, log or announce
 * is captured verbatim, then scanned once at the end so one failure names the
 * exact boundary that leaked.
 */
function createCanarySweep() {
  const captures = []
  return {
    capture(boundary, label, value) {
      captures.push({ boundary, label, haystack: renderValue(value) })
      return value
    },
    boundaries() {
      return [...new Set(captures.map(entry => entry.boundary))].sort()
    },
    countFor(boundary) {
      return captures.filter(entry => entry.boundary === boundary).length
    },
    bytesFor(boundary) {
      return captures.filter(entry => entry.boundary === boundary).reduce((total, entry) => total + entry.haystack.length, 0)
    },
    hits() {
      const found = []
      for (const entry of captures) {
        if (NEEDLES.some(needle => entry.haystack.includes(needle))) found.push(`${entry.boundary}:${entry.label}`)
      }
      return found.sort()
    },
  }
}

// The logger renders to console; capturing console captures the log sink, the
// file logger's input, and anything a crash reporter would scrape off stderr.
function captureConsole(sweep, boundary) {
  const levels = ['log', 'info', 'warn', 'error', 'debug', 'trace']
  const original = new Map(levels.map(level => [level, console[level]]))
  let index = 0
  for (const level of levels) {
    console[level] = (...args) => sweep.capture(boundary, `console.${level}#${index++}`, args)
  }
  return () => {
    for (const [level, fn] of original) console[level] = fn
  }
}

function sweepDirectory(sweep, boundary, dir) {
  let files = 0
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name)
      if (entry.isDirectory()) walk(next)
      else if (entry.isFile()) {
        files++
        sweep.capture(boundary, path.relative(dir, next), fs.readFileSync(next))
      }
    }
  }
  walk(dir)
  return files
}

function encodeWire(sweep, messageName, value) {
  const bytes = c.encode(getEncoding(messageName), value)
  sweep.capture('hrpc-frames', messageName, bytes)
  return bytes
}

// A production-shaped protected rendition: Widevine, so no test-only capability
// is involved anywhere in this fixture. Every field is already world readable.
function drmDescriptorInput(overrides = {}) {
  return {
    scheme: 'cenc',
    drmSystem: 'widevine',
    keyId: '9f3a1c4d5e6b7a8091a2b3c4d5e6f708',
    initData: b4a.toString(b4a.from('pssh:protected-media-key-isolation', 'utf8'), 'base64'),
    licenseEndpoint: 'https://license.example.test/widevine/v1',
    certificateUrl: 'https://license.example.test/widevine/cert',
    issuer: 'example-provider',
    entitlementId: 'entitlement-canary-fixture',
    ...overrides,
  }
}

function coreRef(seed, length = 4) {
  return {
    key: b4a.toString(crypto.data(b4a.from(`core:${seed}`)), 'hex'),
    length,
    treeHash: b4a.toString(crypto.data(b4a.from(`tree:${seed}`)), 'hex'),
    byteLength: 4096,
  }
}

function workRef(id) {
  return createEntityReference({ entityKind: 'work', namespace: 'youtube-video', normalizedIdentifier: `${id}___________`.slice(0, 11) })
}

async function ingestClaim(store, input) {
  const claim = createMediaClaim({ signedAt: FIXED_NOW, ...input })
  const result = await store.ingestClaim(claim.envelope)
  if (result.status !== 'accepted') throw new Error(`claim not accepted: ${result.status}`)
  return claim
}

test('a content key or provider credential cannot enter a signed manifest at all', (t) => {
  const refused = [
    ['a content key beside the descriptor', { contentKey: CANARY }],
    ['a license payload', { licensePayload: CANARY }],
    ['a license response', { licenseResponse: CANARY }],
    ['a provider bearer token', { bearerToken: CANARY }],
    ['a provider password', { providerPassword: CANARY }],
    ['a nested credential bag', { credentials: { apiSecret: CANARY } }],
    ['a key smuggled through the license URL', { licenseEndpoint: `https://license.example.test/v1?token=${CANARY}` }],
    ['a key hex-stuffed into the key IDENTIFIER', { keyId: b4a.toString(b4a.from(CANARY, 'utf8'), 'hex') }],
  ]

  for (const [label, overrides] of refused) {
    let thrown = null
    try {
      createRenditionDescriptor({ purpose: 'original', format: 'video/mp4', core: coreRef('refused'), encryption: drmDescriptorInput(overrides) })
    } catch (error) {
      thrown = error
    }
    t.ok(thrown, `${label} is refused`)
    // A refusal that quotes what it refused is itself the leak: the message
    // travels into logs, crash reports and error responses.
    t.absent(
      NEEDLES.some(needle => `${thrown?.message}\n${thrown?.stack || ''}`.includes(needle)),
      `${label} is refused without repeating the value`
    )
  }

  // The same input minus the smuggled property is a perfectly good rendition,
  // so the refusals above are about the key material and nothing else.
  const clean = createRenditionDescriptor({ purpose: 'original', format: 'video/mp4', core: coreRef('refused'), encryption: drmDescriptorInput() })
  t.ok(clean.encryption, 'the public descriptor itself is accepted')
  t.alike(
    Object.keys(clean.encryption).sort(),
    ['certificateUrl', 'drmSystem', 'entitlementId', 'initData', 'issuer', 'keyId', 'licenseEndpoint', 'scheme', 'version'],
    'and carries exactly the nine public fields, with no room for a tenth'
  )
})

test('the generated schema has no field a content key, license payload or token could ride in', (t) => {
  const schemaFile = new URL('../../spec/spec/schema/schema.json', import.meta.url)
  const structs = JSON.parse(fs.readFileSync(schemaFile, 'utf8')).schema
  t.ok(Array.isArray(structs) && structs.length > 0, 'the generated schema is readable')

  // Names that are never a legitimate wire field in this protocol.
  const forbidden = ['token', 'bearer', 'credential', 'password', 'passphrase', 'contentkey', 'licensekey', 'licensepayload', 'licenseresponse', 'mnemonic', 'seedphrase', 'apikey']
  // The three that ARE legitimate, and the whole of the exception: a user
  // typing their own recovery phrase into their own device's identity RPC.
  // Every other match, on any surface, is a new place to hide key material.
  const identityRecoveryFields = new Set(['identity.seedPhrase', 'recover-identity-request.seedPhrase', 'bootstrap-device-request.mnemonic'])
  // A Hypercore public key is a swarm ADDRESS: it names bytes anyone may
  // replicate and decrypts nothing, which is exactly why relays can cache
  // protected ciphertext without entitlement. Those plus the three public DRM
  // names are the whole allowance on the media surface.
  const publicCoreRefs = [...PUBLIC_DRM_PROPERTY_NAMES, 'coreKey', 'blobCoreKey', 'blobsCoreKey', 'posterBlobsCoreKey', 'thumbnailBlobsCoreKey', 'liveCoreKey']
  const offenders = []
  const mediaOffenders = []
  for (const struct of structs) {
    const isMedia = /^media-|^get-media-|^get-publication-sources|^prepare-media-playback|^get-entity-artwork|^set-source-preference/.test(struct.name || '')
    for (const field of struct.fields || []) {
      const qualified = `${struct.name}.${field.name}`
      const normalized = String(field.name || '').toLowerCase().replace(/[_-]/g, '')
      if (forbidden.some(term => normalized.includes(term)) && !identityRecoveryFields.has(qualified)) offenders.push(qualified)
      // Inside the media surface the rule is the strict one the descriptor
      // enforces: nothing may look like key material.
      if (isMedia && isSecretShapedPropertyName(field.name, publicCoreRefs)) mediaOffenders.push(qualified)
    }
  }
  t.alike(offenders, [], 'no generated message has a token, credential or license-payload field')
  t.alike(mediaOffenders, [], 'no media message has a key-material-shaped field')

  const drm = structs.find(struct => struct.name === 'media-drm-descriptor')
  t.ok(drm, 'the protected-rendition descriptor is part of the generated contract')
  t.alike(
    (drm.fields || []).map(field => field.name),
    ['version', 'scheme', 'drmSystem', 'keyId', 'initData', 'licenseEndpoint', 'certificateUrl', 'issuer', 'entitlementId'],
    'and is exactly the public descriptor - a key IDENTIFIER, not a key'
  )
  const rendition = structs.find(struct => struct.name === 'media-rendition-descriptor')
  t.is(
    (rendition.fields || []).find(field => field.name === 'encryption')?.type,
    '@peartube/media-drm-descriptor',
    'protection reaches the wire only through that descriptor'
  )
})

test('the canary sweep detects a planted canary at every boundary it claims to cover', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-canary-control-'))
  try {
    fs.writeFileSync(path.join(dir, 'planted.bin'), b4a.concat([b4a.alloc(8, 0), b4a.from(CANARY, 'utf8')]))

    const planted = [
      ['hrpc-frames', b4a.from(`\x00\x01${CANARY}`, 'utf8')],
      ['logs', ['prepared source', { note: CANARY }]],
      ['crash-reports', new Error(`boom ${CANARY}`)],
      ['persisted-records', { rows: [{ value: b4a.toString(b4a.from(CANARY, 'utf8'), 'base64') }] }],
      ['archive-evidence', { ranges: [{ note: b4a.from(b4a.toString(b4a.from(CANARY, 'utf8'), 'hex'), 'utf8') }] }],
      ['relay-state', encodePeerFrame({ purpose: 'asset', type: 'locator', payload: b4a.from(CANARY, 'utf8') })],
    ]
    for (const [boundary, value] of planted) {
      const sweep = createCanarySweep()
      sweep.capture(boundary, 'planted', value)
      t.alike(sweep.hits(), [`${boundary}:planted`], `${boundary} detection fires`)
    }

    const disk = createCanarySweep()
    sweepDirectory(disk, 'persisted-state', dir)
    t.alike(disk.hits(), ['persisted-state:planted.bin'], 'on-disk detection fires')

    // And a clean capture of the same shape stays clean, so the detector is not
    // simply always positive.
    const clean = createCanarySweep()
    clean.capture('hrpc-frames', 'clean', b4a.from('PEARTUBE-DEV-CANARY-CONTENT-KEY', 'utf8'))
    t.alike(clean.hits(), [], 'a near-miss prefix is not a hit')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a full protected publication leaves no key, license or token at any backend boundary', async (t) => {
  const sweep = createCanarySweep()
  const cdm = providerCdm()
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-canary-'))
  const restoreConsole = captureConsole(sweep, 'logs')
  setLogLevel('DEBUG')
  const log = logger('ProtectedMediaCanary')
  let store = null

  try {
    // ---- publish: one protected rendition and one public one ---------------
    const protectedRendition = createRenditionDescriptor({
      purpose: 'original',
      format: 'video/mp4',
      core: coreRef('protected'),
      encryption: drmDescriptorInput(),
    })
    const publicRendition = createRenditionDescriptor({ purpose: 'original', format: 'video/mp4', core: coreRef('public') })
    const protectedManifest = createPublicationManifest({
      publisherId: publisher.publicKey,
      sequence: 1,
      title: 'Protected Feature',
      renditions: [protectedRendition],
      keyPair: publisher,
      signedAt: FIXED_NOW,
    })
    const publicManifest = createPublicationManifest({
      publisherId: publisher.publicKey,
      sequence: 2,
      title: 'Public Feature',
      renditions: [publicRendition],
      keyPair: publisher,
      signedAt: FIXED_NOW,
    })
    log.debug('publishing protected title', { publicationId: protectedManifest.publicationId, encryption: protectedRendition.encryption })

    // The signed manifest bytes are exactly what a relay replicates.
    sweep.capture('relay-state', 'publication-manifest', encodePublicationManifest(protectedManifest))
    sweep.capture('persisted-records', 'manifest-body', protectedManifest.body)

    // ---- ingest ------------------------------------------------------------
    const assetManifestStore = createAssetManifestStore({ trustedSigners: [publisher.publicKey] })
    const mediaGraphStore = createMediaGraphStore({ trustedSigners: [publisher.publicKey] })
    await assetManifestStore.ingestManifest(protectedManifest)
    await assetManifestStore.ingestManifest(publicManifest)
    // Separate titles, so "this device cannot play the protected one" is not
    // quietly answered by a public source sitting on the same entity.
    const subject = workRef('canary')
    const publicSubject = workRef('open')
    for (const [manifest, entity] of [[protectedManifest, subject], [publicManifest, publicSubject]]) {
      const claim = await ingestClaim(mediaGraphStore, {
        claimType: 'AvailabilityObservation',
        subjectRefs: [entity],
        payload: { publicationId: manifest.publicationId, availabilityStatus: 'available' },
        confidence: 500,
        keyPair: publisher,
      })
      sweep.capture('relay-state', `media-claim:${manifest.publicationId.slice(0, 8)}`, encodeMediaClaimEnvelope(claim.envelope))
      sweep.capture('persisted-records', `claim-row:${claim.claimId.slice(0, 8)}`, mediaGraphStore.getClaim(claim.claimId))
    }

    // ---- persist: a real Corestore on disk, a real Hyperbee for preferences
    store = new Corestore(storageDir)
    await store.ready()
    const metaCore = store.get({ name: 'peartube-meta' })
    await metaCore.ready()
    const metaDb = new Hyperbee(metaCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await metaDb.ready()
    const sourcePreferenceStore = metaDb.sub('media-source-preferences')

    // The ciphertext a peer, relay or archivist actually holds. Derived from
    // the key, and opaque: holding it entitles nobody to anything.
    const ciphertext = cdm.encrypt(b4a.from('protected media sample payload'.repeat(8), 'utf8'))
    const assetCore = store.get({ name: 'protected-rendition' })
    await assetCore.ready()
    await assetCore.append(ciphertext)
    sweep.capture('relay-state', 'ciphertext-block', ciphertext)

    // The marker really does exist in this process, on the CDM side of the
    // boundary. Without this the sweep below could pass by never having had
    // anything to find.
    t.ok(NEEDLES.some(needle => cdm.licenseResponse.includes(needle)), 'the license response the CDM receives carries the key')
    t.absent(
      NEEDLES.some(needle => b4a.toString(ciphertext, 'latin1').includes(needle)),
      'the ciphertext everyone caches does not'
    )

    // ---- select and play on a device that HAS the CDM ----------------------
    const retained = []
    const openedCores = []
    const apiOptions = {
      mediaGraphStore,
      assetManifestStore,
      sourcePreferenceStore,
      now: () => FIXED_NOW,
      trust: { [b4a.toString(publisher.publicKey, 'hex')]: 50 },
      scopedNetwork: {
        async retainAuthorizedRendition(request) {
          retained.push(request.publicationId)
          return { status: 'retained', renditionId: request.renditionId }
        },
      },
      openCore: async (key) => {
        openedCores.push(key)
        return { close() {} }
      },
    }
    const entitled = createMediaGraphApi({ ...apiOptions, capabilities: { drmSystems: ['widevine'], codecs: null, containers: null } })

    await entitled.setSourcePreference({ entityId: subject.entityId, publicationId: protectedManifest.publicationId, preferred: true })
    const sources = await entitled.getPublicationSources({ entityId: subject.entityId })
    const entity = await entitled.getMediaEntity({ entityId: subject.entityId, includeClaims: true })
    const catalog = await entitled.getMediaCatalog({})
    const played = await entitled.prepareMediaPlayback({ entityId: subject.entityId, publicationId: protectedManifest.publicationId })
    log.info('play resolved', { errorCode: played.errorCode || null, publicationId: played.publicationId })

    t.is(played.success, true, 'an entitled device plays the protected title')
    t.is(played.publicationId, protectedManifest.publicationId)
    const protectedSource = sources.items.find(item => item.publicationId === protectedManifest.publicationId)
    t.is(protectedSource.protected, true, 'the wire says protected')
    t.is(protectedSource.drmSystem, 'widevine', 'and names the system, which is public')
    t.ok(retained.includes(protectedManifest.publicationId), 'the ciphertext was retained for a device that can play it')

    // ---- HRPC: every response the flow produced, through the real encoders --
    for (const [messageName, value] of [
      ['@peartube/get-publication-sources-response', sources],
      ['@peartube/get-media-entity-response', entity],
      ['@peartube/get-media-catalog-response', catalog],
      ['@peartube/prepare-media-playback-response', played],
      ['@peartube/media-drm-descriptor', protectedRendition.encryption],
      ['@peartube/media-publication-source', protectedSource],
      ['@peartube/prepare-media-playback-request', { entityId: subject.entityId, publicationId: protectedManifest.publicationId }],
      ['@peartube/set-source-preference-request', { entityId: subject.entityId, publicationId: protectedManifest.publicationId, preferred: true }],
    ]) {
      const bytes = encodeWire(sweep, messageName, value)
      t.ok(bytes.byteLength > 0, `${messageName} crosses HRPC`)
    }
    const decodedSource = c.decode(getEncoding('@peartube/media-publication-source'), c.encode(getEncoding('@peartube/media-publication-source'), protectedSource))
    t.is(decodedSource.protected, true, 'protection survives the wire')
    t.is(decodedSource.drmSystem, 'widevine')
    const rendition = catalog.items.flatMap(item => item.renditions || []).find(item => item.renditionId === protectedRendition.renditionId)
    t.alike(rendition.encryption, {
      version: 1,
      scheme: 'cenc',
      drmSystem: 'widevine',
      keyId: '9f3a1c4d5e6b7a8091a2b3c4d5e6f708',
      initData: protectedRendition.encryption.initData,
      licenseEndpoint: 'https://license.example.test/widevine/v1',
      certificateUrl: 'https://license.example.test/widevine/cert',
      issuer: 'example-provider',
      entitlementId: 'entitlement-canary-fixture',
    }, 'the descriptor reaches a player verbatim - and it is only the public nine')

    // ---- archive evidence --------------------------------------------------
    const archiveStore = createArchiveStore({ maxObservations: 4, now: () => FIXED_NOW })
    const pledge = createArchivePledge({
      archivistId: archivist.publicKey,
      publicationId: protectedManifest.publicationId,
      renditionId: protectedRendition.renditionId,
      ranges: [{ coreKey: protectedRendition.core.key, start: 0, end: protectedRendition.core.length }],
      retentionUntil: FIXED_NOW + 86_400_000,
      uploadCeilingBytes: 1_048_576,
      issuedAt: FIXED_NOW,
      keyPair: archivist,
    })
    await archiveStore.putPledge(pledge.envelope)
    archiveStore.putObservation({ pledgeId: pledge.envelope.recordId, status: 'challenge-passed', observedAt: FIXED_NOW })
    sweep.capture('archive-evidence', 'pledge-body', pledge.body)
    sweep.capture('archive-evidence', 'pledge-envelope-body', pledge.envelope.body)
    sweep.capture('archive-evidence', 'pledge-signature', pledge.envelope.signature)
    sweep.capture('archive-evidence', 'stored-pledge', archiveStore.getPledge(pledge.envelope.recordId))
    sweep.capture('archive-evidence', 'observations', archiveStore.getObservations(pledge.envelope.recordId))
    sweep.capture('archive-evidence', 'judgement', archiveStore.getAvailabilityJudgement(pledge.envelope.recordId))
    t.is(archiveStore.getAvailabilityJudgement(pledge.envelope.recordId).guaranteed, false, 'archive evidence is evidence, not a promise')

    // ---- relay-visible state ----------------------------------------------
    const topic = deriveAssetTopic({ renditionId: protectedRendition.renditionId })
    sweep.capture('relay-state', 'asset-topic', topic)
    sweep.capture('relay-state', 'locator-frame', encodePeerFrame({
      purpose: 'asset',
      type: 'locator',
      requestId: 1,
      payload: b4a.from(JSON.stringify({
        publicationId: protectedManifest.publicationId,
        renditionId: protectedRendition.renditionId,
        coreKey: protectedRendition.core.key,
        drmSystem: protectedRendition.encryption.drmSystem,
      }), 'utf8'),
    }))
    sweep.capture('relay-state', 'archive-pledge-frame', encodePeerFrame({
      purpose: 'archive',
      type: 'archive-pledge',
      payload: b4a.from(pledge.envelope.body),
    }))
    t.alike(topic, deriveAssetTopic({ renditionId: protectedRendition.renditionId }), 'the topic is derived from the public rendition id alone')

    // ---- a device with NO CDM: refused before any asset work ---------------
    const unentitled = createMediaGraphApi({ ...apiOptions, capabilities: { drmSystems: ['fairplay'] } })
    const retainedBefore = retained.length
    const openedBefore = openedCores.length
    const refused = await unentitled.prepareMediaPlayback({ entityId: subject.entityId, publicationId: protectedManifest.publicationId })
    log.warn('play refused', { errorCode: refused.errorCode })

    const refusedSource = refused.sources.find(item => item.publicationId === protectedManifest.publicationId)
    t.alike(refusedSource.rejectionReasonCodes, ['DRM_UNSUPPORTED'], 'the unplayable protected source says exactly why')
    t.is(refusedSource.eligible, false)
    t.absent(retained.slice(retainedBefore).includes(protectedManifest.publicationId), 'no asset was retained for it')
    t.is(openedCores.length, openedBefore, 'and no rendition core was opened')
    t.is(refused.success, false)
    t.is(refused.errorCode, 'NO_COMPATIBLE_SOURCE', 'Play reports that nothing here can play, not a peer failure')
    encodeWire(sweep, '@peartube/prepare-media-playback-response', refused)

    // A public title is entirely unaffected on the very same device.
    const publicPlay = await unentitled.prepareMediaPlayback({ entityId: publicSubject.entityId })
    t.is(publicPlay.success, true, 'a public source plays on a device with no CDM at all')
    t.is(publicPlay.publicationId, publicManifest.publicationId)
    t.ok(retained.includes(publicManifest.publicationId), 'and its bytes are retained as usual')

    // ---- the same ciphertext is cacheable without entitlement --------------
    const seeder = createAssetSession({ manifest: protectedManifest, openCore: async () => ({ close() {} }) })
    t.is(seeder.isAuthorizedCore(protectedRendition.core.key), true, 'a relay may hold and serve protected ciphertext with no capability at all')
    let sessionRefusal = null
    try {
      await seeder.authorizeCore({ renditionId: protectedRendition.renditionId, coreKey: protectedRendition.core.key })
    } catch (error) {
      sessionRefusal = error
    }
    t.is(sessionRefusal?.errorCode, 'DRM_UNSUPPORTED', 'but it cannot open it for playback, and says so with a bounded code')

    // ---- crash reports: what an uncaught failure would carry out ----------
    // A refusal message or stack that quoted the offending input would leak it
    // into every crash reporter, so the refusals are captured as one.
    sweep.capture('crash-reports', 'session-refusal', sessionRefusal)
    for (const poison of [{ contentKey: CANARY }, { licenseEndpoint: `https://license.example.test/v1?bearer=${CANARY}` }]) {
      try {
        createPublicationManifest({
          publisherId: publisher.publicKey,
          sequence: 3,
          title: 'Poisoned',
          renditions: [{ purpose: 'original', format: 'video/mp4', core: coreRef('poison'), encryption: drmDescriptorInput(poison) }],
          keyPair: publisher,
          signedAt: FIXED_NOW,
        })
        t.fail('a manifest carrying key material must never mint')
      } catch (error) {
        sweep.capture('crash-reports', `publish-refusal:${Object.keys(poison)[0]}`, error)
        log.error('protected publication refused', error)
      }
    }
    t.is(assetManifestStore.getManifestsByRendition(protectedRendition.renditionId).length, 1, 'only the clean publication was ever ingested')

    // ---- persisted state on disk ------------------------------------------
    sweep.capture(
      'persisted-records',
      'source-preference',
      await sourcePreferenceStore.get(`${subject.entityId}\n${protectedManifest.publicationId}`),
    )
    await metaDb.close()
    await store.close()
    store = null
    const files = sweepDirectory(sweep, 'persisted-state', storageDir)
    t.ok(files > 0, `every byte of ${files} persisted files is scanned`)
  } finally {
    restoreConsole()
    setLogLevel('INFO')
    try { await store?.close() } catch { /* already closed */ }
    fs.rmSync(storageDir, { recursive: true, force: true })
  }

  // ---- the sweep ---------------------------------------------------------
  t.alike(sweep.boundaries(), [
    'archive-evidence',
    'crash-reports',
    'hrpc-frames',
    'logs',
    'persisted-records',
    'persisted-state',
    'relay-state',
  ], 'every boundary this fixture can reach was actually captured')
  t.ok(sweep.countFor('logs') > 0, 'the log sink saw the protected flow')
  t.ok(sweep.bytesFor('persisted-state') > 0, 'the on-disk state was read back')
  t.alike(sweep.hits(), [], 'no content key, license payload or provider token at any captured boundary')
})
