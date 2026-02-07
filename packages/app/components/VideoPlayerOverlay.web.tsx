/**
 * VideoPlayerOverlay.web.tsx - Web/SSR stub
 * 
 * During SSR (expo export), we can't load react-native-reanimated.
 * This stub returns null during static rendering, and loads the real component
 * when running in a browser context (Pear desktop).
 */

// Only load the real component in browser context (not during SSR)
let RealVideoPlayerOverlay: any = null

if (typeof window !== 'undefined' && (window as any).Pear) {
  // Pear desktop: load the real component
  try {
    const module = require('./VideoPlayerOverlay')
    RealVideoPlayerOverlay = module.VideoPlayerOverlay
  } catch (err) {
    console.error('[VideoPlayerOverlay.web] Failed to load real component:', err)
  }
}

export function VideoPlayerOverlay() {
  // During SSR: return null (no window)
  // During Pear: return real component
  // During regular web: return null
  if (!RealVideoPlayerOverlay) {
    return null
  }
  return <RealVideoPlayerOverlay />
}
