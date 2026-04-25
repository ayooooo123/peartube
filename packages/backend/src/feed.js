export function createPublicFeedStub() {
  return { getFeed: () => [], getStats: () => ({ totalEntries: 0, hiddenCount: 0, peerCount: 0 }) }
}
