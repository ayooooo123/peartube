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
export { ReactionButton } from './ReactionButton'
export { Scrubber } from './Scrubber'

// Comments module
export { CommentItem } from './CommentItem'
export { CommentComposer } from './CommentComposer'
export { CommentsSection } from './CommentsSection'

// Platform-specific components
export { PearInlineVideoView, getPearInlinePlayerId } from './PearInlineVideoView'

// Hooks
export { useCommentsPolling, useVideoGestures, useMiniPlayerPosition, useLandscapeMode } from './hooks'
