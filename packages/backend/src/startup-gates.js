export const STARTUP_MILESTONE = {
  SWARM_PEER: 'swarm-peer',
  FEED_CHANNEL_OPEN: 'feed-channel-open',
  FEED_SYNC: 'feed-sync',
}

export function createStartupMilestones() {
  return {
    firstSwarmPeerAt: null,
    firstFeedChannelOpenAt: null,
    firstFeedSyncAt: null,
  }
}

export function noteStartupMilestone(milestones, milestone, at = Date.now()) {
  if (!milestones) return createStartupMilestones()

  if (milestone === STARTUP_MILESTONE.SWARM_PEER) {
    milestones.firstSwarmPeerAt ||= at
  } else if (milestone === STARTUP_MILESTONE.FEED_CHANNEL_OPEN) {
    milestones.firstFeedChannelOpenAt ||= at
  } else if (milestone === STARTUP_MILESTONE.FEED_SYNC) {
    milestones.firstFeedSyncAt ||= at
  }

  return milestones
}

export function shouldStartDeferredWarmup(milestones) {
  return Boolean(
    milestones?.firstSwarmPeerAt ||
    milestones?.firstFeedChannelOpenAt ||
    milestones?.firstFeedSyncAt
  )
}

export function createStartupGate() {
  const milestones = createStartupMilestones()
  let resolveWaiter = null
  let waitPromise = null

  function ensureWaitPromise() {
    if (!waitPromise) {
      waitPromise = new Promise((resolve) => {
        resolveWaiter = resolve
      })
    }
    return waitPromise
  }

  function maybeRelease() {
    if (!shouldStartDeferredWarmup(milestones) || !resolveWaiter) return
    const resolve = resolveWaiter
    resolveWaiter = null
    resolve(milestones)
  }

  return {
    milestones,
    noteSwarmPeer(at) {
      noteStartupMilestone(milestones, STARTUP_MILESTONE.SWARM_PEER, at)
      maybeRelease()
      return milestones
    },
    noteFeedChannelOpen(at) {
      noteStartupMilestone(milestones, STARTUP_MILESTONE.FEED_CHANNEL_OPEN, at)
      maybeRelease()
      return milestones
    },
    noteFeedSync(at) {
      noteStartupMilestone(milestones, STARTUP_MILESTONE.FEED_SYNC, at)
      maybeRelease()
      return milestones
    },
    shouldStart() {
      return shouldStartDeferredWarmup(milestones)
    },
    waitUntilOpen(options = {}) {
      if (shouldStartDeferredWarmup(milestones)) return Promise.resolve(milestones)

      const timeoutMs = Number(options?.timeoutMs)
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return ensureWaitPromise()
      }

      return Promise.race([
        ensureWaitPromise(),
        new Promise((resolve) => {
          setTimeout(() => resolve(null), timeoutMs)
        })
      ])
    }
  }
}
