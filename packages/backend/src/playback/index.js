import { createMultiPeerScheduler } from './multi-peer-scheduler.js'

export * from './errors.js'
export * from './transport-guard.js'
export * from './multi-peer-scheduler.js'
export * from './resource-policy.js'
export * from './source-preparation.js'

export function createStaticAssetPlayback({
  coreRef,
  session,
  transport,
  playbackService,
  mimeType = 'video/mp4',
  authorizationKey,
  release,
  ...schedulerOptions
} = {}) {
  if (typeof playbackService?.resolveStaticAssetUrl !== 'function') {
    throw new Error('static asset playback service is required')
  }
  const scheduler = createMultiPeerScheduler({
    ...schedulerOptions,
    coreRef,
    session,
    transport,
  })
  return {
    scheduler,
    ...playbackService.resolveStaticAssetUrl({
      coreRef,
      scheduler,
      mimeType,
      authorizationKey,
      release,
    }),
  }
}
