import test from 'brittle'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { normalizeIndexCandidateFromTransport } from '../../backend/src/search/candidate-contract.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..', '..')
const require = createRequire(import.meta.url)

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function fields(message) {
  return message.fields.map(({ name, type, required, array }) => ({
    name,
    type,
    required: required === true,
    array: array === true,
  }))
}

test('schema source defines bounded typed URL-less candidate contracts', (t) => {
  const source = read('packages/spec/schema.cjs')
  for (const bound of [
    'MAX_INDEX_CANDIDATES = 64',
    'MAX_CANDIDATE_REF_BYTES = 64',
    'MAX_INDEX_EXTERNAL_REFS = 32',
    'MAX_INDEX_SOURCE_INDEXERS = 32',
    'MAX_INDEX_AUDIO_TRACKS = 32',
    'MAX_INDEX_SUBTITLE_TRACKS = 64',
  ]) t.ok(source.includes(bound), `${bound} is recorded at the schema source`)

  for (const name of ['search-index-candidates', 'verify-index-candidate']) {
    t.ok(source.includes(`name: '${name}'`), `${name} is declared at the schema source`)
  }
  for (const flag of [
    'releaseYearPresent',
    'catalogEpochPresent',
    'channelsPresent',
    'widthPresent',
    'heightPresent',
    'byteLengthPresent',
    'blockLengthPresent',
    'blockSizePresent',
    'peersPresent',
    'completeSeedersPresent',
    'observedAtMsPresent',
    'expiresAtMsPresent',
  ]) t.ok(source.includes(`name: '${flag}'`), `${flag} preserves nullable uint presence`)

  const contractSection = source.slice(
    source.indexOf('// Distributed index candidate search'),
    source.indexOf('// Multi-device channel pairing'),
  )
  for (const forbidden of ['streamUrl', 'downloadUrl', 'sourceRecordRef', 'credential', 'cookie', 'controlCapability']) {
    t.absent(contractSection.includes(`name: '${forbidden}'`), `${forbidden} is absent from the wire contract`)
  }
})

test('generated schema exposes exact typed candidate request and response records', (t) => {
  const schema = JSON.parse(read('packages/spec/spec/schema/schema.json'))
  const hrpc = JSON.parse(read('packages/spec/spec/hrpc/hrpc.json'))
  const messages = new Map(schema.schema.map(message => [message.name, message]))
  const commands = new Map(hrpc.schema.map(command => [command.name.replace('@peartube/', ''), command]))

  t.alike(fields(messages.get('search-index-candidates-request')), [
    { name: 'selector', type: '@peartube/index-search-selector', required: true, array: false },
  ])
  t.alike(fields(messages.get('search-index-candidates-response')), [
    { name: 'success', type: 'bool', required: false, array: false },
    { name: 'candidates', type: '@peartube/index-candidate-v2', required: true, array: true },
    { name: 'errorCode', type: 'string', required: false, array: false },
    { name: 'errorMessage', type: 'string', required: false, array: false },
  ])
  t.alike(fields(messages.get('verify-index-candidate-request')), [
    { name: 'candidateRef', type: 'string', required: true, array: false },
  ])
  t.alike(fields(messages.get('verify-index-candidate-response')), [
    { name: 'success', type: 'bool', required: false, array: false },
    { name: 'candidate', type: '@peartube/index-candidate-v2', required: false, array: false },
    { name: 'errorCode', type: 'string', required: false, array: false },
    { name: 'errorMessage', type: 'string', required: false, array: false },
  ])

  const candidateFields = fields(messages.get('index-candidate-v2'))
  t.alike(candidateFields.map(field => field.name), [
    'schemaVersion',
    'candidateRef',
    'work',
    'edition',
    'publication',
    'rendition',
    'asset',
    'provenance',
    'availability',
    'verification',
    'sourceIndexers',
  ])
  for (const [record, pairs] of [
    ['index-work', [['releaseYear', 'releaseYearPresent']]],
    ['index-publication', [['catalogEpoch', 'catalogEpochPresent']]],
    ['index-audio-track', [['channels', 'channelsPresent']]],
    ['index-rendition', [
      ['width', 'widthPresent'],
      ['height', 'heightPresent'],
      ['byteLength', 'byteLengthPresent'],
    ]],
    ['index-asset', [
      ['blockLength', 'blockLengthPresent'],
      ['blockSize', 'blockSizePresent'],
      ['byteLength', 'byteLengthPresent'],
    ]],
    ['index-availability', [
      ['peers', 'peersPresent'],
      ['completeSeeders', 'completeSeedersPresent'],
      ['observedAtMs', 'observedAtMsPresent'],
      ['expiresAtMs', 'expiresAtMsPresent'],
    ]],
  ]) {
    const byName = new Map(fields(messages.get(record)).map(field => [field.name, field]))
    for (const [uintField, presentField] of pairs) {
      t.alike(byName.get(uintField), { name: uintField, type: 'uint', required: true, array: false })
      // Generated Hyperschema metadata conventionally reports bool fields as
      // optional even when the schema source requires them; codec behavior below
      // is the authoritative absent-versus-explicit-zero assertion.
      t.alike(byName.get(presentField), { name: presentField, type: 'bool', required: false, array: false })
    }
  }
  for (const forbidden of ['streamUrl', 'downloadUrl', 'sourceRecordRef', 'credential', 'cookie', 'controlCapability']) {
    t.absent(candidateFields.some(field => field.name === forbidden), `${forbidden} is absent`)
  }
  t.ok(commands.has('search-index-candidates'))
  t.ok(commands.has('verify-index-candidate'))
})

test('generated candidate codec preserves omitted unknowns and concrete verified facts', (t) => {
  const codecs = require('../spec/schema/index.js')
  const minimal = {
    schemaVersion: 2,
    candidateRef: 'A'.repeat(43),
    work: { releaseYear: 0, releaseYearPresent: false, externalRefs: [] },
    publication: {
      publicationId: '11'.repeat(32),
      publisherId: '22'.repeat(32),
      manifestId: '33'.repeat(32),
      catalogEpoch: 0,
      catalogEpochPresent: false,
    },
    rendition: {
      renditionId: '44'.repeat(32),
      width: 0,
      widthPresent: false,
      height: 0,
      heightPresent: false,
      hdrFormats: [],
      audioTracks: [],
      subtitleTracks: [],
      byteLength: 0,
      byteLengthPresent: false,
    },
    asset: {
      blockLength: 0,
      blockLengthPresent: false,
      blockSize: 0,
      blockSizePresent: false,
      byteLength: 0,
      byteLengthPresent: false,
    },
    provenance: {},
    availability: {
      peers: 0,
      peersPresent: false,
      completeSeeders: 0,
      completeSeedersPresent: false,
      observedAtMs: 0,
      observedAtMsPresent: false,
      expiresAtMs: 0,
      expiresAtMsPresent: false,
    },
    verification: { state: 'unverified' },
    sourceIndexers: [],
  }
  const minimalDecoded = codecs.decode(
    '@peartube/index-candidate-v2',
    codecs.encode('@peartube/index-candidate-v2', minimal),
  )
  t.is(minimalDecoded.verification.state, 'unverified')
  t.is(minimalDecoded.publication.catalogHead, null)
  t.is(minimalDecoded.rendition.videoCodec, null)
  t.is(minimalDecoded.work.title, null)
  t.is(minimalDecoded.work.entityId, null)
  t.is(minimalDecoded.rendition.container, null)
  t.is(minimalDecoded.rendition.byteLengthPresent, false)
  t.is(minimalDecoded.asset.byteLengthPresent, false)
  t.is(minimalDecoded.asset.assetId, null)
  t.is(minimalDecoded.availability.observedAtMsPresent, false)
  const minimalPublic = normalizeIndexCandidateFromTransport(minimalDecoded)
  t.is(minimalPublic.work.releaseYear, null)
  t.is(minimalPublic.rendition.byteLength, null)
  t.is(minimalPublic.asset.byteLength, null)
  t.is(minimalPublic.availability.observedAtMs, null)

  const concrete = {
    ...minimal,
    work: {
      ...minimal.work,
      entityId: 'work-1',
      title: 'Pilot',
      releaseYear: 0,
      releaseYearPresent: true,
    },
    publication: {
      ...minimal.publication,
      catalogEpoch: 3,
      catalogEpochPresent: true,
      catalogHead: '66'.repeat(32),
      title: 'Pilot',
    },
    rendition: {
      ...minimal.rendition,
      container: 'video/mp4',
      purpose: 'original',
      width: 0,
      widthPresent: true,
      audioTracks: [{ codec: null, channels: 0, channelsPresent: true, languages: [] }],
      byteLength: 1024,
      byteLengthPresent: true,
    },
    asset: {
      ...minimal.asset,
      assetId: '55'.repeat(32),
      coreKey: '55'.repeat(32),
      treeHash: '77'.repeat(32),
      blockLength: 1,
      blockLengthPresent: true,
      blockSize: 1024,
      blockSizePresent: true,
      byteLength: 1024,
      byteLengthPresent: true,
    },
    availability: {
      peers: 2,
      peersPresent: true,
      completeSeeders: 1,
      completeSeedersPresent: true,
      observedAtMs: 10,
      observedAtMsPresent: true,
      expiresAtMs: 20,
      expiresAtMsPresent: true,
    },
    verification: {
      state: 'source-verified',
      publisherDescriptor: {
        publisherId: '22'.repeat(32),
        publisherRootKey: '88'.repeat(32),
        catalogBootstrapKey: '99'.repeat(32),
        catalogEpoch: 3,
        policySequence: 4,
      },
      catalogHead: {
        viewKey: 'aa'.repeat(32),
        length: 7,
        digest: '66'.repeat(32),
        authorizationStateDigest: 'bb'.repeat(32),
      },
    },
  }
  const concreteDecoded = codecs.decode(
    '@peartube/index-candidate-v2',
    codecs.encode('@peartube/index-candidate-v2', concrete),
  )
  t.is(concreteDecoded.verification.state, 'source-verified')
  t.is(concreteDecoded.asset.coreKey, concrete.asset.coreKey)
  t.is(concreteDecoded.verification.catalogHead.digest, concrete.verification.catalogHead.digest)
  t.is(concreteDecoded.work.releaseYearPresent, true)
  t.is(concreteDecoded.rendition.audioTracks[0].channelsPresent, true)
  const concretePublic = normalizeIndexCandidateFromTransport(concreteDecoded)
  t.is(concretePublic.work.releaseYear, 0)
  t.is(concretePublic.rendition.audioTracks[0].channels, 0)
  t.is(concretePublic.rendition.byteLength, 1024)
  t.is(concretePublic.availability.observedAtMs, 10)
})
