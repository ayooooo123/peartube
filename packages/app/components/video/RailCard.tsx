/**
 * Compact 16:9 card for horizontal rails (Continue Watching, Recommended).
 */
import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { GlassCard } from '@/components/primitives'
import { ThumbnailImage } from './ThumbnailImage'
import { colors } from '@/lib/colors'

export const RAIL_CARD_WIDTH = 220

interface RailCardProps {
  title: string
  subtitle?: string
  thumbnailUrl?: string | null
  duration?: number
  /** 0..1 watched ratio — renders the resume progress bar when > 0 */
  progress?: number
  onPress: () => void
}

function RailCardComponent({ title, subtitle, thumbnailUrl, duration, progress = 0, onPress }: RailCardProps) {
  return (
    <GlassCard padded={false} style={styles.card} onPress={onPress} accessibilityLabel={`Play ${title}`}>
      <View style={styles.thumbFrame}>
        <ThumbnailImage
          thumbnailUrl={thumbnailUrl}
          duration={duration}
          channelInitial={title.charAt(0).toUpperCase()}
        />
        {progress > 0 && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.min(100, progress * 100)}%` }]} />
          </View>
        )}
      </View>
      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={2}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
    </GlassCard>
  )
}

export const RailCard = memo(RailCardComponent)

const styles = StyleSheet.create({
  card: {
    width: RAIL_CARD_WIDTH,
  },
  thumbFrame: {
    width: '100%',
    aspectRatio: 16 / 9,
    overflow: 'hidden',
    borderTopLeftRadius: 15,
    borderTopRightRadius: 15,
    backgroundColor: colors.bg,
  },
  progressTrack: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  info: {
    paddingHorizontal: 12,
    paddingTop: 9,
    paddingBottom: 11,
  },
  title: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 3,
  },
})
