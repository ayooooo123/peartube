export type HostReadyData = {
  blobServerPort: number | null
  blobServerReady?: boolean
  blobServerError?: string | null
  protocolVersion: 6
}

export type HostLifecycleEvent =
  | { type: 'host.ready'; data: HostReadyData }
  | { type: 'host.error'; code: string; message: string; retryable: boolean; storedVersion?: number | null; expectedVersion?: number | null }
  | { type: 'transport.closed'; reason?: string }

export const PROTOCOL_VERSION: 6

export const HOST_ERROR_CODES: {
  readonly HOST_START_FAILED: 'HOST_START_FAILED'
  readonly STORAGE_INIT_FAILED: 'STORAGE_INIT_FAILED'
  readonly PERMISSION_DENIED: 'PERMISSION_DENIED'
  readonly TRANSPORT_DISCONNECTED: 'TRANSPORT_DISCONNECTED'
  readonly PROTOCOL_VERSION_MISMATCH: 'PROTOCOL_VERSION_MISMATCH'
  readonly STORED_PROTOCOL_VERSION_UNSUPPORTED: 'STORED_PROTOCOL_VERSION_UNSUPPORTED'
  readonly CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE'
  readonly OFFLINE_UNAVAILABLE: 'OFFLINE_UNAVAILABLE'
  readonly REPLICATION_TIMEOUT: 'REPLICATION_TIMEOUT'
  readonly PLAYBACK_URL_UNAVAILABLE: 'PLAYBACK_URL_UNAVAILABLE'
  readonly PLAYER_LOAD_FAILED: 'PLAYER_LOAD_FAILED'
}

export function createHostError(
  code: string,
  message: string,
  options?: { cause?: unknown; retryable?: boolean }
): Error & { code: string; retryable: boolean; cause?: unknown }

// --- Protocol client (merged from the former @peartube/protocol) ---

export type ProtocolReadyData = {
  blobServerPort: number | null
  protocolVersion: 6
}

export type ProtocolNetworkStatus = {
  connected: boolean
  peerCount: number
  swarmConnections: number
  swarmPeers: number
  channelsLoaded: number
  swarmOffline: boolean
  swarmOfflineReason: string | null
  swarmListenResolved: boolean
  peerPoolJoined: boolean
  recommendedBoundary: string | null
}

export const PROTOCOL_EVENTS: {
  readonly HOST_READY: 'host.ready'
  readonly HOST_ERROR: 'host.error'
  readonly LOG: 'log'
  readonly UPLOAD_PROGRESS: 'upload.progress'
  readonly DOWNLOAD_PROGRESS: 'download.progress'
  readonly TRANSCODE_PROGRESS: 'transcode.progress'
  readonly MEDIA_GRAPH_UPDATED: 'mediaGraph.updated'
  readonly NETWORK_STATUS: 'network.status'
  readonly VIDEO_STATS: 'video.stats'
  readonly CAST_DEVICE_FOUND: 'cast.deviceFound'
  readonly CAST_DEVICE_LOST: 'cast.deviceLost'
  readonly CAST_PLAYBACK_STATE: 'cast.playbackState'
  readonly CAST_TIME_UPDATE: 'cast.timeUpdate'
  readonly TRANSPORT_CLOSED: 'transport.closed'
}

export const PROTOCOL_EVENT_BINDINGS: ReadonlyArray<readonly [string, string]>

type ProtocolMethod = (request?: any) => Promise<any>
type ProtocolNamespace = Record<string, ProtocolMethod>

export type UploadVideoRequest = {
  filePath: string
  title: string
  description?: string | null
  category?: string | null
  skipThumbnailGeneration?: boolean
  contentKind?: 'episode' | 'movie' | null
  seriesId?: string | null
  seriesTitle?: string | null
  mediaProvider?: 'tmdb' | null
  mediaId?: string | null
  seasonNumber?: number | null
  episodeNumber?: number | null
  expectedEpisodeCount?: number | null
}

export type PublisherRootRecordType =
  | 'publisher.namespace'
  | 'publisher.writer-admission'
  | 'publisher.writer-revocation'
  | 'publisher.root-transition'

export type ProvisionPublisherCatalogResponse = {
  success: boolean
  publisherId: string
  catalogBootstrapKey: Uint8Array
  localWriterKey: Uint8Array
  localSignerKey: Uint8Array
  writable: boolean
  namespaceInitialized: boolean
  admitted: boolean
  errorCode?: string | null
  error?: string | null
}

export type PreparePublisherRootOperationRequest = {
  intentId: string
  publisherId: string
  recordType: PublisherRootRecordType
  signerPublicKey: Uint8Array
  intentExpiresAt: number
  body: Uint8Array
  displaySummaryJson?: string | null
  issuedAt?: number | null
  expiresAt?: number | null
  expiresInMs?: number | null
}

export type PreparePublisherRootOperationResponse = {
  intentId: string
  success: boolean
  publisherId?: string | null
  recordType?: PublisherRootRecordType | null
  unsignedBytes: Uint8Array
  candidateRecordId: Uint8Array
  signerPublicKey: Uint8Array
  intentExpiresAt: number
  bodyLength: number
  issuedAt: number
  expiresAt: number
  displaySummaryJson?: string | null
  error?: string | null
}

export type SubmitPublisherRootOperationRequest = {
  intentId: string
  publisherId: string
  recordType: PublisherRootRecordType
  unsignedBytes: Uint8Array
  candidateRecordId: Uint8Array
  displaySummaryJson?: string | null
  signer: Uint8Array
  signerPublicKey: Uint8Array
  signature: Uint8Array
  allowedSigners?: Uint8Array[] | null
}

export type SubmitPublisherRootOperationResponse = {
  intentId: string
  success: boolean
  valid: boolean
  complete: boolean
  reason?: string | null
  publisherId?: string | null
  recordType?: PublisherRootRecordType | null
  recordId: Uint8Array
  signer: Uint8Array
  signerPublicKey: Uint8Array
  signature: Uint8Array
}

export type MigrationState = 'pending' | 'running' | 'complete' | 'failed' | 'retrying'

export type MigrationStatusRequest = {
  /** UTF-8 identifier, at most 64 bytes. */
  migrationId: string
}

export type MigrationStatusResponse = {
  success: boolean
  migrationId: string
  state: MigrationState
  version: number
  processedCount: number
  importedCount: number
  skippedCount: number
  quarantinedCount: number
  unsupportedCount: number
  remainingCount: number
  retryable: boolean
  updatedAt: number
  errorCode?: string | null
  /** Sanitized fixed diagnostic text, at most 256 UTF-8 bytes. */
  errorMessage?: string | null
  reportDigest?: string | null
}

export type RetryMigrationResponse = MigrationStatusResponse & {
  joined: boolean
}

export type ExportMigrationReportResponse = {
  success: boolean
  migrationId: string
  /** Canonical public-only report, at most 65,536 bytes. */
  reportBytes?: Uint8Array | null
  reportDigest?: string | null
  errorCode?: string | null
}

export type PublisherDeviceStatus =
  | 'authorized'
  | 'stale'
  | 'revoked'
  | 'unable-to-publish'
  | 'authority-lost'

export type PublisherLegacyImportState =
  | 'not-required'
  | 'pending'
  | 'running'
  | 'complete'
  | 'failed'
  | 'retrying'

export type GetPublisherDeviceStatusRequest = {
  /** Public publisher identifier only; exactly 32 bytes when present. */
  publisherId?: Uint8Array
  /** Public device key only; exactly 32 bytes when present. */
  devicePublicKey?: Uint8Array
}

export type GetPublisherDeviceStatusResponse = {
  success: boolean
  publisherId?: Uint8Array | null
  devicePublicKey?: Uint8Array | null
  status: PublisherDeviceStatus
  reasonCode?: string | null
  canPublish: boolean
  canPlayLocal: boolean
  canExportLocal: boolean
  canDeleteLocal: boolean
  canRootTransition: boolean
  catalogEpoch?: number | null
  policyEpoch?: number | null
  admissionExpiresAt?: number | null
  revocationCutoff?: number | null
  legacyImportState?: PublisherLegacyImportState | null
}

export type ExportPortableStateResponse = {
  success: boolean
  schemaVersion: number
  /** Canonical sorted-key UTF-8 JSON, at most 1,048,576 bytes and 2,048 items. */
  manifestBytes?: Uint8Array | null
  manifestDigest?: string | null
  /** At most 2,048. */
  itemCount: number
  errorCode?: string | null
}

export type RestorePortableStateRequest = {
  /** Canonical public-only manifest, at most 1,048,576 bytes and 2,048 items. */
  manifestBytes: Uint8Array
  manifestDigest?: string
}

export type RestorePortableStateResponse = {
  success: boolean
  schemaVersion: number
  importedCount: number
  skippedCount: number
  idempotent: boolean
  errorCode?: string | null
  error?: string | null
}

export type StorageStatsResponse = {
  usedBytes: number
  maxBytes: number
  usedGB: string
  maxGB: number
  seedCount: number
  pinnedCount: number
  totalStorageBytes?: number | null
  totalStorageGB?: string | null
  untrackedStorageBytes?: number | null
  untrackedStorageGB?: string | null
  ownedOriginalBytes?: number | null
  immutablePublicationBytes?: number | null
  pledgedArchiveBytes?: number | null
  localCacheBytes?: number | null
  thumbnailBytes?: number | null
  indexBytes?: number | null
  temporaryTransferBytes?: number | null
  totalCategorizedBytes?: number | null
  evictableBytes?: number | null
  protectedBytes?: number | null
}

export type AssessSourceOffloadRequest = {
  publicationId: string
}

export type AssessSourceOffloadResponse = {
  success: boolean
  eligible: boolean
  publicationId: string
  assessmentId: string
  evidenceDigest: string
  confirmationNonce: string
  expiresAt: number
  policyVersion: number
  byteLength: number
  limitations: string[]
  errorCode?: string | null
}

export type ConfirmSourceOffloadRequest = {
  publicationId: string
  assessmentId: string
  evidenceDigest: string
  confirmationNonce: string
  policyVersion: number
  confirmIrrecoverableRisk: true
}

export type ConfirmSourceOffloadResponse = {
  success: boolean
  publicationId: string
  assessmentId: string
  freedBytes: number
  auditId?: string | null
  reason?: string | null
  errorCode?: string | null
}

export type PreviewStorageLimitResponse = {
  success: boolean
  requestedMaxBytes: number
  currentUsedBytes: number
  requiredEvictionBytes: number
  evictableBytes: number
  protectedBytes: number
  affectedSeedCount: number
  /** Deterministically ordered; at most 32 entries. */
  affectedCategories: string[]
  /** Deterministically ordered; at most 32 entries. */
  consequences: string[]
  feasible: boolean
  /** STORAGE_LIMIT_INFEASIBLE when success is true but feasible is false. */
  errorCode?: string | null
}

export type ArchiveOperatorStatusResponse = {
  success: boolean
  operatorMode: string
  activePledgeCount: number
  healthyPledgeCount: number
  failedPledgeCount: number
  challengeSuccessCount: number
  challengeFailureCount: number
  capacityTotalBytes?: number | null
  capacityReservedBytes?: number | null
  capacityAvailableBytes?: number | null
  capacityRejectionCount: number
  offloadRejectionCount: number
  /** Stable failure codes in deterministic order; at most 64 entries. */
  recentFailureCodes: string[]
  updatedAt: number
  errorCode?: string | null
}

export type ArchiveParticipationStatusResponse = {
  success: boolean
  enabled: boolean
  capacityBytes: number
  maxRequestBytes: number
  reservedBytes: number
  availableBytes: number
  acceptedRequests: number
  knownRequests: number
  receivedPledges: number
  randomRejections: number
  capacityRejections: number
  authorizationRejections: number
  acceptancePermille: number
  errorCode?: string | null
}

export type SetArchiveParticipationRequest = {
  enabled: boolean
  capacityBytes: number
  maxRequestBytes: number
  /** Integer probability in [0, 1000]. */
  acceptancePermille: number
}

export type RequestArchivePublicationRequest = {
  publicationId: string
  renditionId: string
  retentionUntil?: number
}

export type RequestArchivePublicationResponse = {
  success: boolean
  status: string
  requestId: string
  errorCode?: string | null
}

export type MediaPublicationSource = {
  publicationId: string
  publisherId: string
  manifestId: string
  renditionId?: string | null
  score?: number | null
  availabilityScore?: number | null
  formatSupport?: number | null
  moderationPenalty?: number | null
  preferred?: boolean | null
  selected?: boolean | null
  /** Stable codes in deterministic order; at most 32 entries. */
  selectionReasonCodes?: string[] | null
  /** Stable codes in deterministic order; at most 32 entries. */
  rejectionReasonCodes?: string[] | null
  /** Sorted and deduplicated; at most 64 entries. */
  introductionPublisherIds?: string[] | null
  /** Sorted and deduplicated; at most 64 entries. */
  introductionIndexIds?: string[] | null
  /** Sorted and deduplicated; at most 64 entries. */
  moderationFeedIds?: string[] | null
  /** Sorted and deduplicated; at most 64 entries. */
  claimConflictIds?: string[] | null
  /** Sorted and deduplicated; at most 64 entries. */
  provenanceClaimIds?: string[] | null
  scoreMetadataConfidence?: number | null
  scorePublisherTrust?: number | null
  scoreAvailability?: number | null
  scoreFormatSupport?: number | null
  scoreModerationPenalty?: number | null
  archiveState?: string | null
  cacheState?: string | null
  availabilityState?: 'available' | 'unavailable' | 'unknown' | 'stale' | null
  stale?: boolean | null
  incomplete?: boolean | null
}

export type MediaRenditionDescriptor = {
  renditionId: string
  purpose: string
  format: string
  coreKey: string
  coreLength: number
  treeHash: string
  byteLength: number
  segmentIndexId?: string | null
}

export type MediaEntitySummary = {
  entityId: string
  entityKind: string
  localClusterId?: string | null
  title?: string | null
  subtitle?: string | null
  claimCount?: number | null
  conflictCount?: number | null
  sources: MediaPublicationSource[]
  renditions: MediaRenditionDescriptor[]
}

export type MediaAgentSummary = {
  entityId: string
  localClusterId?: string | null
  displayName?: string | null
  claimCount?: number | null
}

export type MediaClaimProvenance = {
  claimId: string
  claimType: string
  issuerId: string
  subjectEntityId?: string | null
  confidence?: number | null
  sourceRank?: number | null
  revoked?: boolean | null
  issuedAt?: number | null
}

export type MediaConflictSummary = {
  conflictId: string
  claimType: string
  subjectEntityId: string
  claimIds: string[]
  preferredClaimId?: string | null
}

export type MediaContributionSummary = {
  agentEntityId: string
  role: string
  workEntityId?: string | null
  publicationId?: string | null
  claimId: string
}

export type MediaPageRequest = {
  cursor?: string
  /** Defaults to 20 and is capped at 50 by the handler. */
  limit?: number
}

export type MediaCatalogResponse = {
  success: boolean
  errorCode?: string | null
  error?: string | null
  items: MediaEntitySummary[]
  nextCursor?: string | null
}

export type MediaEntityResponse = {
  success: boolean
  errorCode?: string | null
  error?: string | null
  entity?: MediaEntitySummary | null
  claims: MediaClaimProvenance[]
  conflicts: MediaConflictSummary[]
}

export type MediaAgentResponse = {
  success: boolean
  errorCode?: string | null
  error?: string | null
  entity?: MediaAgentSummary | null
  claims: MediaClaimProvenance[]
  conflicts: MediaConflictSummary[]
}

export type MediaCollectionItemsResponse = {
  success: boolean
  errorCode?: string | null
  error?: string | null
  items: MediaEntitySummary[]
  nextCursor?: string | null
}

export type MediaAgentContributionsResponse = {
  success: boolean
  errorCode?: string | null
  error?: string | null
  items: MediaContributionSummary[]
  nextCursor?: string | null
}

export type MediaClaimProvenanceResponse = {
  success: boolean
  errorCode?: string | null
  error?: string | null
  claim?: MediaClaimProvenance | null
}

export type SetSourcePreferenceResponse = {
  success: boolean
  errorCode?: string | null
  error?: string | null
}

export type PublicationSourcesResponse = {
  success: boolean
  errorCode?: string | null
  error?: string | null
  /** Page bounded by the request limit and the backend maximum page size. */
  items: MediaPublicationSource[]
  nextCursor?: string | null
}

export type SystemProtocolNamespace = ProtocolNamespace & {
  getStatus(request?: Record<string, never>): Promise<any>
  getSwarmStatus(request?: Record<string, never>): Promise<ProtocolNetworkStatus>
  getBlobServerPort(request?: Record<string, never>): Promise<any>
  getMigrationStatus(request: MigrationStatusRequest): Promise<MigrationStatusResponse>
  retryMigration(request: MigrationStatusRequest): Promise<RetryMigrationResponse>
  exportMigrationReport(request: MigrationStatusRequest): Promise<ExportMigrationReportResponse>
}

export type TransferProtocolNamespace = ProtocolNamespace & {
  getStorageStats(request?: Record<string, never>): Promise<StorageStatsResponse>
  previewStorageLimit(request: { maxBytes: number }): Promise<PreviewStorageLimitResponse>
  getArchiveOperatorStatus(request?: Record<string, never>): Promise<ArchiveOperatorStatusResponse>
  getArchiveParticipation(request?: Record<string, never>): Promise<ArchiveParticipationStatusResponse>
  setArchiveParticipation(request: SetArchiveParticipationRequest): Promise<ArchiveParticipationStatusResponse>
  requestArchivePublication(request: RequestArchivePublicationRequest): Promise<RequestArchivePublicationResponse>
}

export type MediaGraphProtocolNamespace = ProtocolNamespace & {
  getMediaCatalog(request?: MediaPageRequest): Promise<MediaCatalogResponse>
  getMediaEntity(request: {
    entityId: string
    includeClaims?: boolean
    includeConflicts?: boolean
  }): Promise<MediaEntityResponse>
  getMediaCollection(request: {
    entityId: string
    includeClaims?: boolean
    includeConflicts?: boolean
  }): Promise<MediaEntityResponse>
  getMediaCollectionItems(request: MediaPageRequest & {
    collectionEntityId: string
  }): Promise<MediaCollectionItemsResponse>
  getMediaAgent(request: {
    entityId: string
    includeClaims?: boolean
    includeConflicts?: boolean
  }): Promise<MediaAgentResponse>
  getAgentContributions(request: MediaPageRequest & {
    agentEntityId: string
  }): Promise<MediaAgentContributionsResponse>
  getPublicationSources(request: MediaPageRequest & {
    entityId: string
  }): Promise<PublicationSourcesResponse>
  getClaimProvenance(request: {
    claimId: string
  }): Promise<MediaClaimProvenanceResponse>
  setSourcePreference(request: {
    entityId: string
    publicationId: string
    preferred: boolean
  }): Promise<SetSourcePreferenceResponse>
}

export type VideoProtocolNamespace = ProtocolNamespace & {
  uploadVideo(request: UploadVideoRequest): Promise<any>
}

export type PublisherProtocolNamespace = {
  provisionPublisherCatalog(
    request: { publisherId: string; genesisRootKey: Uint8Array }
  ): Promise<ProvisionPublisherCatalogResponse>
  preparePublisherRootOperation(
    request: PreparePublisherRootOperationRequest
  ): Promise<PreparePublisherRootOperationResponse>
  submitPublisherRootOperation(
    request: SubmitPublisherRootOperationRequest
  ): Promise<SubmitPublisherRootOperationResponse>
  getPublisherDeviceStatus(
    request?: GetPublisherDeviceStatusRequest
  ): Promise<GetPublisherDeviceStatusResponse>
  exportPortableState(
    request?: Record<string, never>
  ): Promise<ExportPortableStateResponse>
  restorePortableState(
    request: RestorePortableStateRequest
  ): Promise<RestorePortableStateResponse>
}

export function createProtocolClient(options: {
  stream: any
  HRPCImpl?: new (stream: any) => any
}): {
  stream: any
  rpc: any
  events: {
    on(event: string, listener: (payload: any) => void): () => void
  }
  ready(): Promise<ProtocolReadyData>
  close(): void
  system: SystemProtocolNamespace
  identity: ProtocolNamespace
  publisher: PublisherProtocolNamespace
  channel: ProtocolNamespace
  mediaGraph: MediaGraphProtocolNamespace
  video: VideoProtocolNamespace
  watch: ProtocolNamespace
  transfer: TransferProtocolNamespace
  search: ProtocolNamespace
  shell: ProtocolNamespace
}
