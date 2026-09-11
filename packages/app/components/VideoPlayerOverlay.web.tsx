import { lazy, Suspense } from 'react'

// Browser-only player dependencies must not execute during Expo's Node SSR.
const Impl = lazy(async () => {
  const { VideoPlayerOverlay } = await import('./VideoPlayerOverlayImpl')
  return { default: VideoPlayerOverlay }
})

export function VideoPlayerOverlay() {
  if (typeof window === 'undefined') return null
  return <Suspense fallback={null}><Impl /></Suspense>
}
