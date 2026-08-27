export * from './scoped-session-runtime.js'

function fail (message, code = 'SCOPED_NETWORK_REJECTED') {
  const error = new Error(message)
  error.code = code
  throw error
}

export function createScopedNetworkApi (runtime) {
  if (!runtime) fail('scoped network runtime is required')
  return {
    retainIndexService: request => runtime.retainIndexService(request), releaseIndexService: request => runtime.releaseIndexService(request),
    followPublisher: request => runtime.followPublisher(request), followBootstrapLocator: request => runtime.followBootstrapLocator(request),
    addPublisherFollowReason: request => runtime.addPublisherFollowReason(request), removePublisherFollowReason: request => runtime.removePublisherFollowReason(request),
    getPublisherFollowReasons: request => runtime.getPublisherFollowReasons(request), providePublisherNamespaceProof: request => runtime.providePublisherNamespaceProof(request),
    provideLocalPublisherNamespaceProof: request => runtime.provideLocalPublisherNamespaceProof(request), provideIndexFeed: request => runtime.provideIndexFeed(request),
    subscribeIndexFeed: request => runtime.subscribeIndexFeed(request), followIndexFeed: request => runtime.followIndexFeed(request),
    unfollowIndexFeed: request => runtime.unfollowIndexFeed(request), provideModerationFeed: request => runtime.provideModerationFeed(request),
    subscribeModerationFeed: request => runtime.subscribeModerationFeed(request), followModerationFeed: request => runtime.followModerationFeed(request),
    unfollowModerationFeed: request => runtime.unfollowModerationFeed(request), unfollowPublisher: request => runtime.unfollowPublisher(request),
    publishLocalPublisherCatalog: request => runtime.publishLocalPublisherCatalog(request), rebindLocalPublisherCatalog: request => runtime.rebindLocalPublisherCatalog(request),
    resolveLocalPublisherCatalog: request => runtime.resolveLocalPublisherCatalog(request), retainAuthorizedRendition: request => runtime.retainAuthorizedRendition(request),
    releaseAuthorizedRendition: request => runtime.releaseAuthorizedRendition(request), queryIndexService: request => runtime.queryIndexService(request),
    listAssetRanges: request => runtime.listAssetRanges(request), getActiveAssetPeerIds: request => runtime.getActiveAssetPeerIds(request),
    listPeerAssetRanges: request => runtime.listPeerAssetRanges(request), hasVerifiedAssetBlock: request => runtime.hasVerifiedAssetBlock(request),
    readVerifiedAssetBlock: request => runtime.readVerifiedAssetBlock(request), requestAssetBlocks: request => runtime.requestAssetBlocks(request),
    retainArchiveDiscovery: request => runtime.retainArchiveDiscovery(request), releaseArchiveDiscovery: request => runtime.releaseArchiveDiscovery(request),
    publishArchiveRequest: request => runtime.publishArchiveRequest(request), publishArchivePledge: request => runtime.publishArchivePledge(request),
    publishArchiveChallenge: request => runtime.publishArchiveChallenge(request), publishArchiveChallengeProof: request => runtime.publishArchiveChallengeProof(request),
    retainAuthorizedArchive: request => runtime.retainAuthorizedArchive(request), releaseAuthorizedArchive: request => runtime.releaseAuthorizedArchive(request),
    createAuthorizedArchiveChallengeProof: request => runtime.createAuthorizedArchiveChallengeProof(request), verifyAuthorizedArchiveChallengeProof: request => runtime.verifyAuthorizedArchiveChallengeProof(request),
    publishBootstrapLocator: request => runtime.publishBootstrapLocator(request), getLocalTransportPeerId: () => runtime.getLocalTransportPeerId(),
    listBootstrapLocators: () => runtime.listBootstrapLocators(), getIndexFeedRecords: () => runtime.getIndexFeedRecords(),
    getModerationFeedRecords: () => runtime.getModerationFeedRecords(), getScopedNetworkDiagnostics: () => runtime.getDiagnostics(),
  }
}
