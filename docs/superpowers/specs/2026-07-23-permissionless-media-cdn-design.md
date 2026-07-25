# Permissionless Public Media CDN and Archive Design

Date: 2026-07-23
Status: Approved interactively for implementation planning

## Summary

PearTube is a native-first, permissionless public media network. It combines BitTorrent-like distribution, Archive.org-like preservation, structured media cataloging, and polished client applications. There is no PearTube-operated control plane, no canonical global catalog owner, no centralized moderation authority, and no gated-content requirement in the initial design.

Publishers sign publications and provenance claims. Peers independently choose what to discover, index, download, cache, archive, moderate, and re-share. Clients materialize a unified media graph so media from unrelated publishers appears as coherent creators, series, seasons, albums, recordings, and collections without erasing publisher provenance.

The core architectural rule is:

> Publishers own publications. They do not own the abstract work, recording, edition, collection, or frontend organization.

## Product Direction

PearTube should support:

- public video, audio, podcasts, live recordings, movies, shows, episodes, songs, albums, creator archives, and arbitrary curated collections;
- immutable, independently verifiable media assets;
- sparse streaming and BitTorrent-like multi-peer distribution;
- voluntary long-term preservation with measurable retention evidence;
- permissionless publisher, curator, indexer, archivist, and moderation feeds;
- locally materialized, centralized-looking media libraries;
- client-selected trust, ranking, filtering, and optional AI classification;
- native mobile and desktop clients first, with browser delivery explicitly deferred.

## Goals

- Replace the single global consumer swarm with scoped bootstrap, publisher, asset, and live-event discovery.
- Make media bytes immutable and independently cacheable by asset, rendition, and range.
- Separate abstract media identity from a publisher's concrete upload.
- Merge partial collections and duplicate publications across unrelated publishers.
- Preserve provenance and conflicts instead of manufacturing global canonical truth.
- Make catalog, index, moderation, and archival participation permissionless.
- Bound every peer-controlled resource before allocation, parsing, verification, download, or persistence.
- Make archival reliability observable through signed pledges, possession proofs, and delivery history.
- Present one coherent, polished client library even when the underlying graph is assembled from many publishers.

## Non-Goals

- Gated or paid content in the initial implementation.
- A PearTube-operated commercial control plane.
- A centralized catalog, identity service, relay registry, moderation service, billing system, or availability authority.
- Browser P2P transport in the initial implementation.
- Global deletion of already replicated public media.
- A globally authoritative merge of conflicting media identities.
- Mandatory AI moderation or AI-derived metadata.
- Peer-payment incentives or payment-grade bandwidth accounting.
- Guaranteed permanence when no peer voluntarily retains a complete copy.

## System Principles

### Permissionless does not mean unbounded

Any peer may publish or index content, but no peer may force another peer to allocate unbounded memory, CPU, disk, bandwidth, connections, or cryptographic verification work.

### Provenance is not authority

A publisher signature proves who made a claim and whether the claim was modified. It does not prove that metadata, collection membership, source identity, or moderation labels are true.

### Organization is entity-centric

Frontend organization follows media entities and collection membership, not uploader channels. Publisher identity remains visible as provenance and source selection.

### Public media is irrevocably public

Retraction removes a publisher's reference or recommendation. It cannot erase independent copies. Clients may hide, stop retaining, or stop serving content according to local policy.

### P2P durability is evidence, not magic

A current remote bitfield proves present possession, not future retention. Archive confidence comes from complete-copy evidence, signed retention pledges, recurring challenges, and delivery history.

### Local policy is the final authority

Each client controls discovery, trust, ranking, moderation, storage, upload, battery, thermal, and metered-network behavior.

## Network Roles

Roles describe behavior, not privileged identities. One process may perform several roles.

- **Publisher:** signs a publisher namespace and publishes media publications and claims.
- **Viewer:** fetches playback ranges and may temporarily cache them.
- **Seeder:** serves locally retained ranges.
- **Archivist:** voluntarily retains complete assets or renditions for longer periods.
- **Curator:** publishes collections, equivalence claims, ordering claims, and recommendations.
- **Indexer:** publishes searchable references and metadata projections.
- **Auditor:** challenges archival pledges and publishes signed observations.
- **Moderator:** publishes optional signed labels, blocklists, allowlists, or annotations.

No role is assigned by a central registry. Clients decide which identities and observations to trust.

## Trust Model and Threat Model

The design assumes:

- arbitrary Sybil identities;
- hostile publishers and malformed metadata;
- spam catalogs and fake collection membership;
- replayed announcements;
- peers that exaggerate capacity, uptime, or retention intent;
- peers that disappear during playback;
- malicious or compromised curators, indexers, archivists, and moderation feeds;
- conflicting source identifiers and deliberate impersonation;
- content that is illegal, harmful, mislabeled, or unwanted by some clients;
- validly signed but malicious media containers, codec bitstreams, images, subtitles, transcripts, and archive files;
- decompression bombs, pathological container indexes, extreme dimensions, and native decoder vulnerabilities;
- network observers that can correlate public DHT participation and peer IP addresses;
- local device compromise as a threat to publisher keys.

A publisher signature proves provenance, not media safety. Container probing, thumbnail extraction, playback decoding, archive inspection, classification, and transcoding treat all bytes as hostile. Implementations must validate numeric bounds before allocation, cap duration, dimensions, tracks, nesting, index entries, and decompressed output, never auto-extract archive bundles, propagate cancellation and resource budgets into parsers, and isolate native decoders where the platform permits.

The design guarantees integrity and provenance for signed records and Hypercore blocks. It does not guarantee metadata truth, global availability, anonymity, erasure, safe decoder behavior, or universal moderation.

## Privacy Model

PearTube does not provide anonymity. Publisher and index follows, catalog fetches, asset requests, archive challenges and pledges, and seeding join observable network topics or exchange data with peers. Those peers and network observers may correlate IP addresses, requested topics, timing, and repeated participation across sessions. mDNS and other local discovery can also reveal that a device is running PearTube to nearby networks.

Trust weights, source ranking, moderation decisions, retention choices, and the decision to accept an index or moderation feed are evaluated locally. That local policy is not a privacy layer: fetching a publisher, index, moderation feed, or asset and serving retained bytes remains network-visible even when the resulting allow, block, or ranking decision never leaves the device.

Product copy and settings must distinguish local policy from network-visible fetch and seeding behavior. They must not imply that encrypted peer connections conceal peer IP addresses, topic participation, public signatures, or archive activity, and must not claim anonymity or traffic-analysis resistance.

## Media Entity Graph

PearTube keeps five media identity domains distinct and adds one non-media identity domain for creators and contributors.

### Work

A `Work` is the abstract creative item:

- a song;
- a television episode;
- a film;
- a YouTube video;
- a podcast episode;
- a music video;
- a trailer, extra, or lesson.

A work may have several recordings, editions, cuts, performances, or language variants.

### Recording or Edition

A `Recording` or `Edition` is a specific realization of a work:

- original studio recording;
- live performance;
- remaster;
- director's cut;
- broadcast edit;
- dubbed version;
- restored scan;
- alternate mix.

The protocol uses one common entity envelope with typed `RecordingOfClaim` and `EditionOfClaim` relations rather than assuming every media kind uses identical terminology.

### Publication

A `Publication` is one publisher's signed release of a recording or edition. It binds provenance and an immutable asset manifest. Two publishers may release the same recording independently.

### Asset Rendition

An `AssetRendition` identifies exact immutable bytes optimized for a purpose:

- original source archive;
- 1080p CMAF stream;
- 720p CMAF stream;
- FLAC audio;
- AAC audio;
- thumbnail;
- subtitle track.

### Collection

A `Collection` organizes works, recordings, editions, publications, agents, or nested collections:

- creator archive;
- television series;
- season;
- album release;
- disc;
- playlist;
- podcast;
- course;
- franchise;
- user-curated set.

Collections are not owned by the publisher of any one member. Any identity may publish a collection, structure, or membership claim.

### Agent or Creator

An `Agent` represents a person, group, organization, character, or other credited creator/contributor independently of any uploader or publisher identity. A publisher may also claim to represent an agent, but the relationship is evidence, not automatic equality.

`ContributionClaim` relates a typed agent reference to a work, recording/edition, publication, or collection with a role such as artist, author, director, performer, composer, host, producer, or uploader. Unified creator pages resolve agent equivalence and contribution claims using the same provenance and conflict rules as media entities.

## Entity Reference Model

Every relationship endpoint uses a typed entity reference. References are claims, not automatically trusted truth.

```text
EntityRef
  entityKind
  namespace
  namespaceVersion
  normalizationVersion
  normalizedIdentifier
```

`entityKind` is one of `work`, `recording`, `edition`, `publication`, `rendition`, `collection`, or `agent`. The namespace and normalization versions prevent later normalization changes from silently changing identity.

Examples:

- `work / youtube-video / v1 / <id>`
- `agent / youtube-channel / v1 / <id>`
- `recording / musicbrainz-recording / v1 / <mbid>`
- `edition / musicbrainz-release / v1 / <mbid>`
- `collection / tmdb-tv / v1 / <id>`
- `work / tmdb-episode / v1 / <series>:<season>:<episode>`
- `work / imdb-title / v1 / <id>`
- `work / podcast-guid / v1 / <guid>`
- `work / canonical-url / v1 / <normalized-url>`
- `recording / av-fingerprint / v1 / <algorithm>:<digest>`

A deterministic reference key is:

```text
referenceKey = hash(
  "peartube/entity-reference/v1" ||
  entityKind ||
  namespace ||
  namespaceVersion ||
  normalizationVersion ||
  normalizedIdentifier
)
```

An entity without an external identifier uses an issuer-scoped native reference:

```text
nativeReferenceKey = hash(
  "peartube/native-entity/v1" ||
  entityKind ||
  issuerRootKey ||
  issuerLocalId
)
```

Issuer-scoped native references prevent accidental collision but do not make the issuer the global owner of the abstract entity. Equivalence claims may connect native and external references.

Reference equality is strong evidence only when the client trusts the claim issuer or independently verifies the reference. A malicious publisher may falsely claim a well-known source ID.

## Canonical Signed Records

Every single-signer protocol record other than a Hypercore block uses `SignedEnvelope`. Root rotation and recovery use the separate `MultiSignedEnvelope` below. Section-specific code blocks describe `canonicalBody` fields; they do not define ad hoc signature formats.

```text
SignedEnvelope
  recordType
  schemaMajor
  schemaMinor
  issuerIdentityKey
  signerKey
  policyEpoch
  issuerSequence?
  signedAt
  expiresAt?
  bodyLength
  canonicalBody
  recordId
  signature
```

```text
recordId = hash(
  "peartube/signed-record-id/v1" ||
  recordType ||
  schemaMajor ||
  schemaMinor ||
  issuerIdentityKey ||
  signerKey ||
  policyEpoch ||
  issuerSequence ||
  signedAt ||
  expiresAt ||
  canonicalEncode(canonicalBody)
)

signature = sign(
  signerSecretKey,
  "peartube/signed-record-signature/v1" ||
  recordType ||
  recordId
)
```

Root transitions use a common body and a bounded signature set:

```text
MultiSignedEnvelope
  recordType
  schemaMajor
  schemaMinor
  issuerIdentityKey
  policyEpoch
  issuerSequence
  signedAt
  bodyLength
  canonicalBody
  transitionId
  signatures[]
    signerKey
    signature
```

```text
transitionId = hash(
  "peartube/multisigned-record-id/v1" ||
  recordType ||
  schemaMajor ||
  schemaMinor ||
  issuerIdentityKey ||
  policyEpoch ||
  issuerSequence ||
  signedAt ||
  canonicalEncode(canonicalBody)
)

transitionSignature = sign(
  signerSecretKey,
  "peartube/multisigned-record-signature/v1" ||
  recordType ||
  transitionId
)
```

`transitionId` excludes individual signer keys so every signer covers the same bytes. `signatures` is unique, lexicographically ordered by signer key, and capped at 16 entries before verification. Normal rotation requires exactly the authorized old root and declared new root. Recovery requires the declared new root plus at least the configured number of distinct keys from the previously committed recovery set. Extra, duplicate, unrecognized, or role-invalid signatures reject the transition.

`recordType` is domain separation. `bodyLength` is validated before decoding. Each record type has an exact body codec and byte/count maxima. Unknown major versions or mandatory record types are quarantined and never applied; only explicit length-delimited optional minor extensions may be skipped.

Persistent publisher records require `issuerSequence` and are authorized by the deterministic catalog reducer at the record's declared `policyEpoch`, writer sequence, and catalog position. `signedAt` does not decide writer authority or ordering. Expiry is checked with bounded skew after cryptographic/catalog authorization.

Ephemeral records require a nonce inside their typed body plus `expiresAt` and a bounded replay window. Publisher-issued ephemeral records name the publisher policy epoch and remain untrusted until the signer/device admission and root transition chain are verified from a trusted catalog checkpoint or genesis. Self-issued peer pledges and auditor observations use the peer/auditor identity as `issuerIdentityKey` and policy epoch zero.

Device admission/revocation, namespace descriptors, manifests, bootstrap announcements, live descriptors, archival pledges, challenge responses, availability observations, index records, and moderation records use `SignedEnvelope`. Root rotation and recovery use `MultiSignedEnvelope`.

## Claim Model

All cross-entity assertions use signed, immutable, tagged claims. Core claim types are:

- `EntityMetadataClaim`
- `ExternalReferenceClaim`
- `EquivalentEntityClaim`
- `EditionOfClaim`
- `RecordingOfClaim`
- `ContributionClaim`
- `CollectionStructureClaim`
- `CollectionMembershipClaim`
- `SupersedesClaim`
- `RetractionClaim`
- `ModerationClaim`
- `AvailabilityObservation`

Claims specialize `SignedEnvelope`; their canonical body is:

```text
ClaimRecordBody
  claimType
  subjectRefs[]
  typedPayload
  evidenceRefs[]
  confidence?
```

Each `claimType` has an exact tagged payload schema, required typed endpoints, numeric domains, and byte/count maxima. Unknown major versions and unknown mandatory claim types are retained only in quarantine and never applied. Unknown optional minor fields may be skipped only when their enclosing codec is explicitly length-delimited.

`claimId` is the enclosing `SignedEnvelope.recordId`. Verification checks the envelope ID/signature, delegated signer capability, policy epoch, issuer sequence, time bounds, exact payload schema, and typed endpoint compatibility before projection.

Semantic claims do not expire unless their variant explicitly allows expiry. Availability and moderation observations may expire. Sequence is monotonic per signer; duplicate claim IDs are idempotent. Replayed sequences with different bytes are rejected.

`RetractionClaim` names exact prior claim IDs. Only the same issuer root, through a signer currently authorized for the target claim family, may retract its claim. A curator cannot retract another publisher's claim; it can publish a competing claim or moderation decision. Retraction affects local projection from its effective catalog position forward and never deletes history.

`SupersedesClaim` names exact prior and replacement claim, manifest, publication, or collection-release IDs. It is authoritative only inside the same issuer namespace unless a client independently trusts it as equivalence evidence. It never rewrites another issuer's records.

`ContributionClaim` contains a typed agent reference, typed subject reference, role, optional credited name, and optional bounded ordinal.

`CollectionMembershipClaim` contains:

```text
collectionRef
memberRef
memberRole
position
  season?
  episode?
  disc?
  track?
  part?
  explicitIndex?
positionLabel?
insertionId
```

Coordinates are non-negative bounded integers. `insertionId` is the claim-local stable tie-break key. A `CollectionStructureClaim` may declare expected bounded slots, ranges, named groups, and nesting. Missing-member UI is shown only from a trusted structure claim, never inferred from the largest observed episode or track number.

Clients order accepted memberships by the collection-specific coordinate tuple, then explicit index, then insertion ID. Conflicting order or structure claims remain issuer-attributed and visible; no claim mutates a globally owned collection.

## Equivalence and Conflict Resolution

No global merge operation exists. Clients create local clusters from trusted claims and observed evidence.

Evidence strength, from strongest to weakest, generally includes:

1. byte-identical asset hash;
2. independently verified provider identifier;
3. matching robust audiovisual or audio fingerprint;
4. trusted curator equivalence claim;
5. publisher equivalence claim;
6. compatible duration, release date, creator, and normalized metadata;
7. local AI similarity suggestion.

Clients retain the underlying claim graph and may split a previously merged cluster when conflicting evidence appears.

A local resolver returns:

```text
ResolvedEntity
  localEntityId
  entityKind
  memberReferences[]
  acceptedClaims[]
  rejectedClaims[]
  conflicts[]
  confidence
  preferredMetadata
```

`localEntityId` is a local materialized-view key. It is not a global protocol identifier.

## Partial and Duplicate Collections

Unrelated publishers may contribute different parts of one collection.

Example:

```text
Publisher A -> Show X S01E01
Publisher B -> Show X S01E03
Publisher C -> Show X S01E02 and S01E04
```

The client resolves the episode work references and collection membership claims into:

```text
Show X
  Season 1
    Episode 1 -> Publication A
    Episode 2 -> Publication C
    Episode 3 -> Publication B
    Episode 4 -> Publication C
```

If multiple publications resolve to one episode, the client renders one episode with alternate sources. Source selection considers local trust, verified fingerprint agreement, format support, availability, resolution, and moderation policy.


## Whole-Collection Publications

A season pack, creator archive, or album import publishes:

- one collection, structure, or edition claim set;
- independently playable child publications;
- ordered membership claims;
- optional original archive bundles.

An album must not become one opaque playback blob. Tracks remain independently addressable, searchable, cacheable, streamable, and seedable. An original ZIP, disc image, cue sheet, or source directory may also be retained as an archival rendition.

Atomic publication uses an immutable, content-addressed collection-release batch. The publisher writes and seals the batch containing child publication references and membership claims, then appends one bounded catalog commit referencing its hash. Clients project none of the batch until that commit and every referenced page verifies. Large releases are paged inside the immutable batch; they are fetched and verified lazily under catalog budgets.

## Publisher Key Custody

The universal backend never imports Expo, Keychain, Keystore, or desktop credential APIs and never receives a vault export operation. It depends on a narrow local `PublisherSigner` interface supplied by the platform runner. Mobile implements the signer in the React Native shell with `expo-secure-store`; desktop implements it in the privileged Bun main process with an OS credential store. The Electrobun web renderer never holds root secret bytes. Device-writer keys remain separate backend/Corestore credentials and sign ordinary catalog operations; publisher roots sign only namespace, delegation, revocation, rotation, and recovery records.

The local signer interface supports only:

```text
createOrImportRoot(intentId, secretInput?)
getRootPublicKey()
signPreparedRecord(intentId, recordType, canonicalUnsignedBytes)
deleteRoot(intentId)
getAvailability() -> available | locked | missing | denied
```

There is no `getSecret`, arbitrary-message signing, or remote invocation. A shell-created, single-use `intentId` binds an explicit user action to one allowed record type, expected public fields, expiry, and canonical unsigned bytes. The backend returns those exact bounded bytes plus a candidate `recordId` or `transitionId`; the shell broker independently decodes them, checks the public fields against the pending intent, recomputes the ID with the shared canonical codec, constant-time compares it with the candidate, and only then asks the vault to sign the protocol's domain-separated recomputed ID. A separate summary is display-only and never authorizes a signature. The backend then verifies and appends the returned signature. Locked, denied, expired, replayed, malformed, mismatched, background, or unknown-intent requests fail closed.

Normal IPC messages never carry root secret bytes. One migration-only path may move an existing plaintext backend root into the privileged shell vault over the authenticated local app/worker channel: the backend reads the legacy file once, the shell imports it without exposing it to the renderer, verifies public-key and sign/challenge continuity, returns a migration acknowledgement, and only then may the backend delete the source and temporary files. Both sides zero transient buffers and redact the entire request from logs. A crash before acknowledgement preserves the source for retry; a crash after verified acknowledgement resumes deletion idempotently. The migration path is removed or permanently disabled once migration state is committed.

Recovery keys are independent and offline by default. A recovery transition accepts externally produced signatures only after `MultiSignedEnvelope` role/quorum verification; it never causes recovery secrets to be copied into the device vault.

## Publisher Namespace

A publisher namespace uses one Autobase with independent device-writer Hypercores and a deterministic Hyperbee materialized view. Devices never share one feed secret.

The namespace descriptor contains:

```text
publisherId
publisherRootKey
catalogBootstrapKey
catalogEpoch
profileRef
policySequence
recoveryKeys[]
recoveryThreshold
previousRootKey?
rootTransitionProof?
```

`publisherId` is the immutable namespace identity derived from the genesis root: `hash("peartube/publisher-id/v1" || genesisRootKey)`. Root rotation changes the active signing key and catalog epoch, not `publisherId`.

The descriptor, writer admission/revocation, and view-head announcement use `SignedEnvelope`. Root rotation and recovery records use `MultiSignedEnvelope`; every required root/recovery signature covers the same signer-independent `transitionId`.

The root authorizes shorter-lived device writers through signed admission records containing writer key, capabilities, policy epoch, first accepted sequence, expiry, and admission nonce. Every writer operation contains its writer sequence and policy epoch. The deterministic Autobase apply function validates the exact operation schema and the writer authorization before changing the view.

A revocation record is root-authorized and contains a new policy epoch plus `acceptedThroughSequence` for each revoked writer. Operations above that cutoff are rejected regardless of arrival or linearization time. Operations at or below the cutoff remain deterministic, idempotent history. Autobase's deterministic linearization orders otherwise concurrent accepted operations; the operation ID is the final stable tie-break.

The advertised catalog head is the deterministic view key, length, and signed digest after apply. A currently authorized announce-capable device may advertise the head with a locator digest for its authorization state. The advertised length is a hint, never an allocation instruction.

Normal root rotation requires signatures from both old and new roots. Recovery after loss requires a new-root signature plus the configured M-of-N recovery-key quorum and increments the catalog epoch. If neither the old root nor the configured recovery quorum is available, publisher continuity is unrecoverable; implementations must not invent an unsigned recovery path.

The publisher catalog records:

- writer admission, capability, revocation, and root-transition records;
- publication manifests;
- publisher-authored entity and contribution claims;
- collection releases;
- supersession and retraction claims.

It does not own the global entity graph.

## Immutable Asset Manifest

Publication and manifest IDs are non-circular:

```text
manifestId = hash(
  "peartube/manifest-id/v1" ||
  canonicalEncode(ManifestBody)
)

publicationId = hash(
  "peartube/publication-id/v1" ||
  publisherId ||
  manifestId
)
```

The manifest is a `SignedEnvelope` whose canonical body produces `manifestId`; its outer typed payload also contains `publicationId`. The envelope signer must have publication capability at the catalog operation's policy epoch and sequence. Neither ID nor the signature appears inside the hashed manifest body.

```text
ManifestBody
  schemaMajor
  schemaMinor
  publisherId
  publisherRootKey
  publisherSequence
  workClaims[]
  editionOrRecordingClaims[]
  contributionClaims[]
  collectionClaims[]
  renditions[]
  sourceProvenance[]
  contentFingerprints[]
  publishedAt
  previousManifestId?
  encryptionDescriptor?
```

Each rendition descriptor contains:

```text
renditionId
purpose
mimeType
codec
width?
height?
bitrate?
duration
coreKey
coreLength
treeHash
byteLength
segmentIndexDescriptor
```

```text
renditionId = hash(
  "peartube/rendition-id/v1" ||
  canonicalEncode(
    purpose,
    formatDescriptor,
    coreKey,
    coreLength,
    treeHash,
    byteLength,
    segmentIndexDescriptor
  )
)
```

The segment index is a separate immutable content-addressed compact-binary object unless it fits the protocol's small inline bound. Its descriptor binds codec/version, core key, core length, tree hash, byte length, entry count, and digest. Each entry binds sequence, block or byte start/count, decode timestamp, duration, and independent-decode status. Validation enforces monotonic non-overlapping coordinates, exact core/byte bounds, duration and entry-count ceilings, and bounded page decoding before a scheduler consumes it.

Media storage separates:

- original archival material;
- playback-optimized video renditions;
- audio renditions;
- artwork;
- subtitles and transcripts;
- future derived data.

The same verified rendition descriptor and core may be referenced by several publishers without sharing a writer key. Rendition cores and segment indexes are immutable after publication. A corrected or improved release creates a new manifest and a `SupersedesClaim`.

## Discovery Surfaces

### Bootstrap discovery

A small public bootstrap topic carries only bounded, expiring `SignedEnvelope<BootstrapAnnouncementBody>` records:

```text
publisherId
activeRootKey
catalogBootstrapKey
catalogEpoch
catalogHeadLength
catalogHeadHash
expiresAt
nonce
authorizationChainDigest
```

Before catalog authorization is known, a bootstrap announcement is only an unauthenticated locator protected from accidental mutation by its as-yet-untrusted signature. The client uses the stable `catalogBootstrapKey` to sync a bounded prefix from genesis or from its last trusted checkpoint, validates root transitions and device admission, then verifies the envelope signer had announce capability at `catalogEpoch`. Only then does it accept the head hint. `authorizationChainDigest` is a cache/comparison hint, not proof. `catalogHeadLength` never causes eager allocation or full replication.

Bootstrap discovery must not exchange complete catalogs, open media cores, authorize pinning, trigger mirror delegation, or expose generic Corestore replication.

### Publisher discovery

```text
publisherTopic = hash(
  "peartube/publisher/v1" ||
  publisherId ||
  catalogEpoch
)
```

Clients join a publisher topic only when following, resolving, crawling, or explicitly inspecting that publisher. Root/catalog transitions are verified from the stable genesis-bound catalog or a previously trusted checkpoint. A bootstrap announcement can locate that catalog but cannot substitute for the transition chain.

### Asset discovery

```text
assetTopic = hash(
  "peartube/asset/v1" ||
  assetProtocolMajor ||
  renditionId
)
```

The topic binds immutable rendition content, not publication identity. Several publications that reference the exact same verified rendition core join the same swarm. Publication provenance remains in signed manifests.

Only peers playing, caching, auditing, or archiving that rendition join its topic. Segment-index descriptors are fetched from the manifest before media scheduling and are subject to the same content and resource verification.

### Live discovery and lifecycle

A publisher appends a `SignedEnvelope<LiveEventBody>` to its catalog:

```text
eventId
publisherId
workAndCollectionClaims[]
scheduledAt?
eventNonce
initialPolicy
```

```text
eventId = hash(
  "peartube/live-event-id/v1" ||
  publisherId ||
  eventNonce
)
```

The event state machine is monotonic:

```text
scheduled
  -> live(epoch 0)
  -> live(epoch N)
  -> ended | aborted
  -> sealed publication
```

Each epoch descriptor is a `SignedEnvelope` from a device authorized for that event at the referenced publisher policy epoch. Its canonical body binds event ID, epoch number, previous epoch digest, writable media core key, initialization/index commitment, start and expiry, codec descriptor, and bounded DVR window. Epoch topics are:

```text
liveTopic = hash(
  "peartube/live/v1" ||
  eventId ||
  epochNumber ||
  epochDescriptorDigest
)
```

Only the authorized event writer appends media to an epoch core. Viewers reject regressions, skipped transition proofs, expired epochs, and descriptors that do not chain to the catalog event. Late joiners resolve the current signed epoch through the publisher catalog, fetch the bounded initialization/index window, then join that epoch topic.

An `ended` or `aborted` record closes new epoch traffic. Sealing validates the final epoch chain and publishes immutable recording and optional DVR renditions through the normal manifest/catalog commit path. A sealed recording is a normal publication; mutable live cores are never reused as indefinitely growing CDN allocation units.

## Versioned Compatibility and Deprecation Policy

Publisher namespace descriptors, publisher catalog pages, bootstrap locators, and
curator/index-feed pages carry the same signed compatibility advertisement:

- `minimumProtocolMajor`, the protocol major required to interpret the record;
- `protocolMinor`, the additive producer minor; and
- `requiredCapabilities`, a canonical list of behavior the consumer must
  implement before it may open, project, or follow references from the record.

The current protocol supports exactly major `1`. A record whose
`minimumProtocolMajor` is not the locally selected major is rejected; the field
does not authorize cross-major interpretation. Minor changes are compatible
when every required capability is supported. Unknown optional, bounded,
length-delimited minor data may be ignored only where its containing schema
marks it optional. Unknown required capability identifiers always fail closed.

Capability identifiers are lowercase ASCII protocol identifiers. Producers
deduplicate and lexicographically sort them before signing. Consumers require
that canonical order rather than silently normalizing signed remote input. A
compatibility advertisement contains at most 32 identifiers, each at most 64
UTF-8 bytes and at most 2,048 bytes in total. The mandatory surface identifiers
for this major are `publisher-catalog:v1`,
`publisher-catalog-page:v1`, `bootstrap-locator:v1`, and `index-feed:v1`.

Compatibility rejection happens after authenticity validation but before
catalog batch ingestion, index projection, catalog-chain traversal, or opening
referenced data. The stable machine-readable errors are:

- `PROTOCOL_ADVERTISEMENT_REQUIRED` for absent or partial compatibility
  metadata;
- `PROTOCOL_MAJOR_UNSUPPORTED` for a major mismatch; and
- `PROTOCOL_CAPABILITY_UNSUPPORTED` for the first unsupported identifier in
  canonical order.

An omitted compatibility advertisement is not an implicit major-1 default.
Code accepting an older persisted encoding must provide a complete explicit
legacy declaration—major, minor, and required capabilities—and that declaration
still passes the same local-major and capability checks. The only production
exception at this cutover is an already persisted version-1 publisher namespace
descriptor. The first rebuild binds the exception to the exact previously
accepted signed genesis operation ID, migrates the derived descriptor to the
canonical advertised encoding, and retains only that bounded durable marker for
subsequent rebuilds. Fresh or merely byte-equivalent legacy genesis candidates
remain invalid. The legacy declaration is fixed to major 1 and
`publisher-catalog:v1`. Online bootstrap locators, publisher catalog pages,
and index pages must advertise compatibility; their verifiers do not opt into
an omission fallback.

The persisted-descriptor exception lasts for two stable release trains that
emit the new fields, and no less than 90 days after the first such stable
release. Removal requires a release note and a migration/export path verified
against retained version-1 fixtures. After the window, omission returns
`PROTOCOL_ADVERTISEMENT_REQUIRED`; it never selects another discovery plane.
Major support ends only in a release that can preserve or export local
publisher evidence before refusing the old state.

A bundled client encountering stored backend state from another major must stop
before opening or projecting that state and present an upgrade or verified
export/restore path. It must not start a differently versioned bundled backend
against the store, reinterpret the state as a minor change, or query a remote
service as recovery.

Compatibility pressure never restores the deleted global-feed data plane,
generic Corestore replication, unsigned mirror steering, or their RPC aliases.
An incompatible publisher/index remains quarantined at its last verified
checkpoint. Users may upgrade, migrate/export, or unsubscribe; the client does
not silently downgrade or fall back.

## Peer Wire Protocol

Peer messages use versioned compact binary encodings. JSON is prohibited on untrusted peer channels.

### Connection and channel state

Every connection follows:

```text
Noise authenticated
  -> purpose bound
  -> protocol negotiated
  -> active
  -> closed
```

Noise authenticates the remote transport key. The first Protomux channel is bound to exactly one discovery purpose and topic digest. Protocol names are purpose- and major-version-specific:

- `peartube/bootstrap/1`
- `peartube/publisher/1`
- `peartube/asset/1`
- `peartube/live/1`
- `peartube/archive/1`

The first bounded handshake frame contains purpose, topic digest, protocol major/minor, supported feature bits, local hard limits, nonce, Noise transport key, optional application peer key, and a signature that binds the application key to the transport session when an application identity is claimed.

Major-version mismatch or purpose/topic mismatch closes the channel. Minor versions negotiate the intersection of feature bits and the stricter limit for each resource. No request, core replication, or application message is accepted before negotiation completes.

Each message family has an explicit tagged dispatch table. Unknown mandatory message tags, unknown state-changing claim variants, and unsupported required feature bits close or quarantine the channel. Unknown optional length-delimited minor extensions may be skipped. They are never silently applied.

### Message and work bounds

Every message type defines maxima for:

- encoded frame bytes;
- strings and arrays;
- references and claims;
- nested depth;
- concurrent requests;
- signature verifications;
- in-flight media bytes;
- messages per peer per time window.

Bounds are enforced before allocation or expensive verification. Oversized, malformed, replayed, or abusive input closes the channel and affects local peer reputation.

Corestore replication is scoped to explicitly authorized publisher or rendition cores. A connection to a bootstrap topic never receives a generic replication surface for every locally open core.

### Catalog and crawl budgets

Frame bounds do not make an infinite valid feed safe. Each client enforces local per-peer, per-feed, and global budgets for:

- catalog head advance accepted per sync window;
- bytes and records fetched per sync window and day;
- retained catalog bytes;
- materialized projection rows and bytes;
- queued signature and proof verification;
- collection-release pages;
- crawl depth, publisher fan-out, and index-feed expansion;
- concurrent feed and asset sessions.

Catalog heads are hints. Sync is lazy and paginated. A followed publisher may receive a larger explicit budget but never an unbounded one. When a budget is exhausted, the client stops at the last verified head, persists the cursor, reports a structured partial/quarantined state, and requires a later budget window or explicit local policy change. It does not allocate to the advertised head, discard already verified state, or continue crawling recursively.

## Playback Distribution

The scheduler prioritizes:

1. initialization and index blocks;
2. blocks immediately ahead of the playhead;
3. the current seek target;
4. a bounded forward playback window;
5. rare useful blocks;
6. background fill allowed by local policy.

Full-file background downloads must not compete with startup or seeks.

Peers exchange bounded availability summaries for the current rendition. Declared speed and capacity are hints. Selection uses observed throughput, latency, failures, and verified block delivery.

## Local Retention Policies

Clients expose explicit modes:

- **Streaming only:** temporary playback window.
- **Recent:** bounded retention of recently played media.
- **Followed:** retain selected publishers or collections.
- **Archivist:** preserve complete assets using rarity and local policy.
- **Manual pin:** retain selected publications until explicitly released.
- **Original preservation:** retain source-quality archival renditions.

All modes obey local limits for disk, upload rate, concurrent peers, in-flight bytes, metered networks, battery, thermal state, and foreground/background activity.

## Archival Pledges

An archivist may publish a `SignedEnvelope<ArchivePledgeBody>`:

```text
peerKey
publicationId
renditionId
retainedRanges
expectedRetentionUntil
maximumUploadRate
createdAt
expiresAt
nonce
```

`pledgeId` is the envelope `recordId`. The archivist peer key is both the pledge subject and the self-issued envelope identity; publisher authorization is not implied.

A pledge is evidence of intent, not an enforceable guarantee. Clients score it using observed history.

## Proof of Possession

Auditors issue unpredictable multi-block challenges sampled across pledged ranges. Challenges and responses use typed `SignedEnvelope` records. A challenge body binds pledge ID, auditor key, fresh nonce, sampled block indexes, issued monotonic time, response deadline, and protocol transcript digest. The response body contains the requested blocks, Hypercore proofs, pledge ID, nonce, transcript digest, and responder identity before the deadline. Availability observations are likewise typed envelopes signed by the observing auditor.

Sampling covers different regions over repeated challenges. Clients record sample coverage, response bytes, latency, expiry, success/failure, complete-range evidence, and observed delivery history. Challenge size and deadline are chosen so fetched-on-demand relaying is more expensive and more visible, but the protocol does not claim to prove that bytes were stored locally: a sufficiently fast cooperating peer can still relay them.

Archive confidence therefore remains probabilistic and local. Different public keys are not sufficient evidence of independent operation. A client may group owned devices, explicitly trusted archivists, or locally identified failure domains and discounts correlated/Sybil identities.

The last publisher/original copy is never deleted automatically from generic peer evidence. Deleting it requires an explicit per-publication user action after a warning that the network cannot guarantee recovery.

Automatic eviction applies only to replaceable cache copies and requires all of:

- a local policy that explicitly enables automatic cache offload;
- at least two currently reachable, explicitly trusted archivist identities in separately configured failure domains;
- complete-range pledges that outlive the local retention deadline;
- repeated recent multi-block challenge coverage;
- successful recent delivery observations;
- no local manual/original-preservation pin.

Failure of any condition preserves the cache copy until ordinary local quota policy requires a user-visible decision.

## Permissionless Index and Curator Feeds

There is no canonical global feed. Any identity may publish an index or curator feed containing:

- typed entity references;
- bounded publication locators;
- collection definitions and structure claims;
- collection membership claims;
- equivalence and contribution claims;
- tags and rankings;
- methodology and model metadata;
- signatures.

A resolvable publication locator is:

```text
PublicationRef
  publisherId
  activeRootKey
  catalogBootstrapKey
  catalogEpoch
  publicationId
  manifestId
  catalogSequenceHint?
  catalogBlockHint?
  rootTransitionProofDigest
```

Sequence, block positions, and `rootTransitionProofDigest` are untrusted hints. A client uses the stable `catalogBootstrapKey` to sync from genesis or its last trusted checkpoint under catalog budgets, validates the publisher identity/root transition and device-admission chain, verifies the catalog operation and manifest ID, and then confirms the publication envelope signature. A stale hint falls back to bounded publisher-head synchronization; it never makes the indexer authoritative and never triggers media download.

Search results remain untrusted references until the client resolves and verifies their publisher manifests and claims.

Clients combine:

- followed publisher feeds;
- subscribed curator and index feeds;
- local history and library state;
- peer recommendations;
- local full-text and semantic indexes;
- optional locally budgeted crawling.

## Spam and Sybil Resistance

The permissionless catalog assumes unlimited identities. Defenses are local and layered:

- hard wire and catalog bounds;
- peer and publisher rate limits;
- announcement TTLs and replay suppression;
- duplicate and fingerprint collapse;
- trust inherited from explicitly followed publishers and curators;
- local delivery and availability history;
- quarantine for unknown high-volume publishers;
- optional proof-of-work for unsolicited bootstrap announcements;
- no media download caused by metadata discovery alone;
- bounded signature-verification queues;
- per-topic and per-peer connection ceilings.

Proof-of-work is optional policy, not a universal publishing requirement.

## Client-Side Moderation

Moderation controls what a client discovers, displays, downloads, retains, and serves. It does not delete network content.

Filtering applies independently to:

- publisher;
- publication;
- work;
- agent or creator;
- recording or edition;
- collection;
- claim issuer;
- curator/index feed;
- exact asset rendition.

An agent-level decision applies to the agent projection and the accepted `ContributionClaim` edges that name it. Whether related media is blurred, hidden, not downloaded, or not seeded is an explicit local role policy: for example, a client may treat `uploader` differently from `performer` or `director`. Blocking an agent never silently rewrites or retracts the underlying contribution or media claims.

Any identity may publish signed moderation feeds containing labels, blocklists, allowlists, age ratings, sensitive-content warnings, copyright claims, or recommendations. Clients choose which feeds to trust.

The moderation pipeline is:

1. structural and cryptographic verification;
2. hard local safety limits;
3. local allowlists and blocklists;
4. subscribed moderation feeds;
5. publisher and curator trust;
6. metadata and thumbnail classification;
7. optional sampled-frame or audio analysis;
8. optional full-media analysis;
9. local action: visible, blurred, hidden, not downloaded, or not seeded.

AI annotations include model identity, model version, analyzed ranges, labels, confidence, and timestamp. AI never mutates publisher-authored records or creates global canonical truth.

## Unified Client Projection

Clients materialize a local media graph from publisher, curator, index, moderation, and AI claims.

The UI renders:

- unified creator pages;
- unified series and season pages;
- albums with discs and ordered tracks;
- creator/channel archives assembled across publishers;
- completeness indicators and missing-member placeholders;
- alternate publication/source selection;
- provenance and trust details;
- visible conflict indicators when identity or ordering is uncertain.

Default playback chooses a publication using local policy:

```text
score =
  metadataConfidence
  + publisherTrust
  + verifiedFingerprintAgreement
  + observedAvailability
  + formatPreference
  - moderationPenalty
```

The ordinary UI presents one title and one play action. Advanced views expose sources, claims, conflicts, and archival state.

## Future Encryption Extension

Encryption is deferred. The public protocol reserves optional manifest fields for an encryption mode, key identifier, and epoch.

A future system may use Hypercore block encryption or Autobase blind encryption so storage peers retain ciphertext and a client receives a decryption key after satisfying a task. The exact blind-replication behavior must be verified against the selected Hypercore and Autobase versions before becoming a protocol dependency.

Once a recipient receives the decryption key and plaintext, cryptography cannot prevent redistribution. This does not affect the public-media design.

## Current Architecture Cutover

The following existing work is reusable:

- signed channel root descriptors as migration evidence;
- PublicBee projections;
- structured source and content metadata;
- channel catalog normalization;
- content fingerprints and import claims;
- Hypercore sparse replication;
- playback range prioritization;
- seeding quota and cache clearing;
- seed-pin message canonicalization and verification patterns;
- local semantic search foundations;
- the current ordered shutdown path that closes feed, discovery, playback, blob, blind-peer, swarm, metadata, and Corestore resources.

The following must be replaced or constrained:

- the global `peartube-network` data plane;
- unbounded JSON peer feed messages;
- unsigned relay mirror claims;
- generic Corestore replication across bootstrap peers;
- device-writer-sized media cores as the publication unit;
- local writer-role metadata without deterministic replicated authorization;
- source offload based on two transient peers;
- resource policies that do not govern actual replication;
- mobile initialization that drops platform-specific swarm settings;
- plaintext publisher primary-key files.

The existing shutdown implementation is a prerequisite to preserve and extend, not a redesign target. New subsystems must register with the same ownership contract and prove idempotent cleanup.

## Implementation Boundaries

The implementation should introduce focused modules instead of expanding `storage.js`, `api.js`, or `public-feed.js` further:

- publisher roots, device delegation, recovery, and deterministic catalog apply;
- media entity IDs, typed claims, and resolution;
- immutable asset manifests, segment indexes, and rendition storage;
- scoped network topics, negotiation, and bounded peer protocols;
- archival pledges, proof challenges, confidence, and local retention policy;
- local media graph, creator/contribution, and search projections;
- moderation feeds and policy evaluation;
- hostile-media validation and bounded decoder/prober workers.

Existing app-facing HRPC remains the local host contract. Peer-to-peer protocols use separate versioned compact encodings.

## Required Invariants

1. Publisher ownership never determines abstract work, agent, or collection ownership.
2. Work, recording/edition, publication, asset rendition, collection, agent, and publisher IDs remain type- and domain-distinct.
3. Claims are immutable, canonically encoded, signed, bounded, typed, and issuer-attributed.
4. Publisher writer admission, revocation cutoffs, catalog apply, and root recovery are deterministic.
5. No peer-controlled message is decoded without a byte bound.
6. Every peer channel binds one purpose/topic and negotiates protocol and resource limits before work.
7. Bootstrap connections do not expose generic content replication.
8. Media discovery is scoped by publisher, rendition, or live event epoch.
9. Metadata discovery alone never triggers media download or pinning.
10. Catalog, projection, verification, crawl, disk, and egress work all have cumulative local budgets.
11. Mirror and archival claims are signed by the identity making the claim.
12. The last publisher/original copy is never automatically deleted from generic peer evidence.
13. Signed media bytes remain hostile input to bounded, cancellable parsers and decoders.
14. Client policy controls storage, egress, moderation, trust, entity resolution, and archival confidence.
15. Retraction never claims to erase independently retained public media.
16. AI output is derived evidence, never canonical truth.
17. The final frontend projection preserves provenance and unresolved conflicts.

## Verification Strategy

Each protocol and model layer requires deterministic tests:

- canonical encoding, domain separation, and stable typed IDs;
- exact field, cumulative-work, and size rejection;
- publisher writer admission, revocation cutoff, root rotation, and recovery quorum;
- signature, protocol negotiation, unknown-variant, and replay validation;
- cross-publisher entity and agent clustering with conflict preservation;
- partial and whole collection assembly, ordering, and trusted completeness;
- alternate-source selection;
- publisher/rendition/live topic separation;
- no replication from bootstrap metadata alone;
- cache, catalog, verification, crawl, and upload budget enforcement;
- hostile media metadata, container, archive, image, and subtitle bounds;
- possession challenge transcript, coverage, expiry, and relay limitations;
- mandatory explicit confirmation before last publisher/original copy deletion;
- moderation at publisher, publication, entity, agent, collection, and rendition levels;
- optional AI annotations remaining non-authoritative;
- mobile policy propagation and shutdown cleanup.

Multi-peer integration tests must cover Sybil saturation, malformed frames, cumulative valid-feed exhaustion, disappearing peers, duplicate publications, conflicting metadata, revoked writers, false mirror advertisements, fetched-on-demand archive responses, sparse asset availability, stale publication locators, live epoch skew, and protocol version skew.

## Success Criteria

The architecture is implemented when:

- a publisher can release an immutable media publication with original and streaming renditions;
- publisher roots rotate or recover without permitting revoked device writers to continue accepted publication;
- unrelated publishers can contribute different members of one collection;
- duplicate publications resolve to one local work while remaining separately attributable;
- creator pages assemble typed agent and contribution claims rather than uploader identity;
- clients display coherent shows, seasons, albums, creator archives, and collections assembled across publishers;
- bootstrap, publisher, rendition, and live-event discovery are isolated and protocol-negotiated;
- public media streams from multiple peers with bounded instantaneous and cumulative resource use;
- archivists can publish pledges and answer transcript-bound possession challenges without those observations being misrepresented as guaranteed local retention;
- last publisher/original copy deletion always requires explicit per-publication user action;
- local indexes and curator feeds resolve bounded publication locators to verified publisher manifests;
- moderation and optional AI filtering remain entirely client-selected;
- signed hostile media is processed only through bounded, cancellable ingestion and playback paths;
- no centralized catalog, policy, moderation, or availability authority is required.
