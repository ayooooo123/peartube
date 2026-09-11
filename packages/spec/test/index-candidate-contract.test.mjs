import test from 'brittle'
import { createRequire } from 'node:module'
import { normalizeIndexCandidateFromTransport } from '../../backend/src/search/candidate-contract.js'

const require = createRequire(import.meta.url)


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
