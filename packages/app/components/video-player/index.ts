/**
 * Video Player Components
 *
 * Modular components for the video player overlay.
 * See packages/app/lib/video-player for the context providers.
 */

// Foundation
export * from './constants'
export * from './formatters'
export { styles } from './styles'
export { desktopStyles } from './desktopStyles'

// Self-contained memoized components
export { P2PStatsBar } from './P2PStatsBar'
export { ChannelInfo } from './ChannelInfo'
export { ActionButton } from './ActionButton'
export { TimeDisplay } from './TimeDisplay'
export { Scrubber } from './Scrubber'

// Context-connected components
export { SeekBar } from './SeekBar'
export { ControlsOverlay } from './ControlsOverlay'
export { VideoInfo } from './VideoInfo'
export { ActionButtons } from './ActionButtons'

// Comments module
export { CommentItem } from './CommentItem'
export { CommentComposer } from './CommentComposer'
export { CommentsSection } from './CommentsSection'

// Platform-specific components
export { MiniPlayerControls } from './MiniPlayerControls'
export { MiniPlayerProgressBar } from './MiniPlayerProgressBar'
export { DesktopMiniPlayer } from './DesktopMiniPlayer'
export { LoadingOverlay } from './LoadingOverlay'
export { SeekFeedback } from './SeekFeedback'
export { VideoContainer } from './VideoContainer'
export { MpvMobileVideoView } from './MpvMobileVideoView'

// Hooks
export { useCommentsPolling, useVideoGestures, useMiniPlayerPosition, useLandscapeMode } from './hooks'
