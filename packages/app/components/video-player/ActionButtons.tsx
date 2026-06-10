/**
 * ActionButtons - Action buttons row (like, share, download, cast)
 *
 * Displays the horizontal row of action buttons below the video.
 */

import { memo } from 'react'
import { View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { ActionButton } from './ActionButton'
import { ReactionButton } from './ReactionButton'
import { styles } from './styles'

interface ActionButtonsProps {
  // Reactions
  reactionCounts: Record<string, number>
  userReaction: string | null
  onToggleReaction: (type: string) => void

  // Download
  isDownloaded: boolean
  isDownloading: boolean
  onDownload: () => void

  // Cast (optional)
  castAvailable?: boolean
  isCasting?: boolean
  isConnectingCast?: boolean
  onCastPress?: () => void
}

export const ActionButtons = memo(function ActionButtons({
  reactionCounts,
  userReaction,
  onToggleReaction,
  isDownloaded,
  isDownloading,
  onDownload,
  castAvailable,
  isCasting,
  isConnectingCast,
  onCastPress,
}: ActionButtonsProps) {
  return (
    <View style={styles.actions}>
      <ReactionButton
        reactionCounts={reactionCounts}
        userReaction={userReaction}
        onToggleReaction={onToggleReaction}
      />
      <ActionButton
        icon={({ color, size }) => <Feather name="thumbs-down" color={color} size={size} />}
        label={`Dislike${reactionCounts.dislike ? ` (${reactionCounts.dislike})` : ''}`}
        active={userReaction === 'dislike'}
        onPress={() => onToggleReaction('dislike')}
      />
      <ActionButton
        icon={({ color, size }) => <Feather name="share-2" color={color} size={size} />}
        label="Share"
      />
      {castAvailable && (
        <ActionButton
          icon={({ color, size }) => <Feather name="cast" color={color} size={size} />}
          label={isCasting ? "Casting" : "Cast"}
          active={isCasting}
          onPress={onCastPress}
          loading={isConnectingCast}
        />
      )}
      <ActionButton
        icon={({ color, size }) =>
          isDownloaded
            ? <Feather name="check" color={color} size={size} />
            : <Feather name="download" color={color} size={size} />
        }
        label={isDownloaded ? "Saved" : "Download"}
        onPress={isDownloaded ? undefined : onDownload}
        loading={isDownloading}
      />
      <ActionButton
        icon={({ color, size }) => <Feather name="more-horizontal" color={color} size={size} />}
        label="More"
      />
    </View>
  )
})
