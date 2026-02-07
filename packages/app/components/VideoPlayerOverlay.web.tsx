let Impl: React.ComponentType | null = null

if (typeof window !== 'undefined') {
  try {
    Impl = require('./VideoPlayerOverlayImpl').VideoPlayerOverlay
  } catch {}
}

export function VideoPlayerOverlay() {
  if (!Impl) return null
  return <Impl />
}
