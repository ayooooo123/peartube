import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { formatContentBadge } from '@/lib/formatters'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { NetworkStatusPill } from './NetworkStatusPill'

export interface MediaCockpitItem {
  id?: string | number | null
  videoId?: string | number | null
  title?: string | null
  subtitle?: string | null
  channelName?: string | null
  creatorName?: string | null
  channel?: {
    name?: string | null
  } | null
  thumbnailUrl?: string | null
  thumbnail?: string | null
  posterUrl?: string | null
  backdropUrl?: string | null
  stillUrl?: string | null
  sourceCount?: number | null
  sourceProviderName?: string | null
  publisherName?: string | null
  archiveStatus?: string | null
  availabilityStatus?: string | null
  conflicts?: Array<unknown> | null
  provenance?: Array<unknown> | null
  localEntityId?: string | null
  publicationId?: string | null
  duration?: number | null
  durationSec?: number | null
  contentKind?: string | null
  classification?: {
    type?: string | null
    year?: number | null
    season?: number | null
    episode?: number | null
  } | null
  category?: string | null
}

export interface HeroFeatureCardProps {
  item: MediaCockpitItem | null | undefined
  peers?: number | null
  onPress: () => void
  onChannelPress?: () => void
  onDetailsPress?: () => void
  /**
   * What this device can currently do with the feature. A hero that always
   * reads "Play" promises playback even while the media is still replicating,
   * so callers pass the real state and the card stops offering to play.
   */
  playable?: boolean
  availabilityLabel?: string | null
}


function pickString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function getEntityBadge(item: MediaCockpitItem): string | null {
  const formatted = formatContentBadge(item)
  const kind = pickString(item.contentKind, item.classification?.type)
  if (kind === 'movie') return 'Movie'
  if (kind === 'episode' || kind === 'tv') return 'Episode'
  if (kind === 'season' || kind === 'album' || kind === 'collection') return 'Collection'
  if (kind === 'song' || kind === 'music') return 'Music'
  return formatted || (item.localEntityId ? 'Work' : null)
}

function getArtwork(item: MediaCockpitItem): string | null {
  return pickString(item.backdropUrl, item.posterUrl, item.stillUrl, item.thumbnailUrl, item.thumbnail)
}

function getSourceSummary(item: MediaCockpitItem): string {
  if (typeof item.sourceCount === 'number' && item.sourceCount > 1) return `${item.sourceCount} sources`
  return pickString(item.sourceProviderName, item.publisherName, item.channelName, item.channel?.name) || '1 source'
}

function getArchiveSummary(item: MediaCockpitItem): string | null {
  const status = pickString(item.archiveStatus, item.availabilityStatus)
  if (!status) return null
  if (status === 'local' || status === 'complete-local') return 'Local copy'
  if (status === 'cached' || status === 'retained') return 'Retained nearby'
  if (status === 'pledged' || status === 'archived') return 'Archive evidence'
  if (status === 'unavailable' || status === 'missing') return 'Missing source'
  return status
}

function HeroFeatureCardComponent({
  item,
  peers,
  onPress,
  onChannelPress,
  onDetailsPress,
  playable = true,
  availabilityLabel = null,
}: HeroFeatureCardProps) {
  if (!item) return null

  const title = pickString(item.title) || 'Featured media'
  const subtitle = pickString(
    item.subtitle,
    item.creatorName,
    item.sourceProviderName,
    item.publisherName,
    item.channelName,
    item.channel?.name,
  )
  const badge = getEntityBadge(item)
  const thumbnailUrl = getArtwork(item)
  const duration = typeof item.duration === 'number' && item.duration > 0
    ? item.duration
    : typeof item.durationSec === 'number' && item.durationSec > 0
      ? item.durationSec
      : undefined
  const channelInitial = title.charAt(0).toUpperCase()
  const archiveSummary = getArchiveSummary(item)
  const conflictCount = Array.isArray(item.conflicts) ? item.conflicts.length : 0
  const hasProvenance = Boolean(item.localEntityId || item.publicationId || (Array.isArray(item.provenance) && item.provenance.length > 0))

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={playable ? `Play ${title}` : `Open ${title}, ${availabilityLabel || 'not playable yet'}`}
      style={styles.card}
    >
      <View style={styles.mediaFrame}>
        <ThumbnailImage thumbnailUrl={thumbnailUrl} duration={duration} channelInitial={channelInitial} style={styles.thumbnail} />
        <View pointerEvents="none" style={styles.scrimTop} />
        <View pointerEvents="none" style={styles.scrimBottom} />
        <View style={styles.mediaTopRow}>
          <Text style={styles.kicker} numberOfLines={1}>Permissionless media CDN</Text>
          <NetworkStatusPill peers={peers} tone={peers && peers > 0 ? 'live' : 'ready'} />
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.metaRow}>
          {badge ? <Text style={styles.badge} numberOfLines={1}>{badge}</Text> : null}
          <Text style={styles.meta} numberOfLines={1}>{getSourceSummary(item)}</Text>
          {archiveSummary ? <Text style={styles.meta} numberOfLines={1}>{archiveSummary}</Text> : null}
        </View>
        <Text style={styles.title} numberOfLines={2}>{title}</Text>
        {subtitle ? (
          onChannelPress ? (
            <Pressable onPress={onChannelPress} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Open publisher for ${title}`}>
              <Text style={[styles.subtitle, styles.subtitleAction]} numberOfLines={1}>{subtitle}</Text>
            </Pressable>
          ) : (
            <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>
          )
        ) : null}
        <View style={styles.signalRow}>
          {onDetailsPress ? (
            <Pressable onPress={onDetailsPress} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Open media evidence for ${title}`}>
              <Text style={hasProvenance ? styles.signalActive : styles.signal} numberOfLines={1}>provenance</Text>
            </Pressable>
          ) : (
            <Text style={hasProvenance ? styles.signalActive : styles.signal} numberOfLines={1}>provenance</Text>
          )}
          {conflictCount > 0 ? <Text style={styles.signalWarn} numberOfLines={1}>{conflictCount} conflict{conflictCount === 1 ? '' : 's'}</Text> : null}
        </View>
        <View style={playable ? styles.playButton : styles.pendingButton}>
          <Ionicons name={playable ? 'play' : 'cloud-download-outline'} size={16} color={playable ? colors.onPrimary : colors.text} />
          <Text style={playable ? styles.playText : styles.pendingText}>
            {playable ? 'Play selected source' : (availabilityLabel || 'Awaiting replication')}
          </Text>
        </View>
      </View>
    </Pressable>
  )
}

export const HeroFeatureCard = memo(HeroFeatureCardComponent)

const styles = StyleSheet.create({
  pendingButton: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  pendingText: {
    color: colors.text,
    fontFamily: fonts.headingMedium,
    fontSize: 14,
  },
  card: {
    marginHorizontal: 16,
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    shadowColor: '#000000',
    shadowOpacity: 0.32,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 6,
  },
  scrimTop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  mediaFrame: {
    position: 'relative',
    backgroundColor: colors.bg,
  },
  thumbnail: {
    borderRadius: 0,
  },
  scrimBottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 96,
    backgroundColor: 'rgba(0,0,0,0.36)',
  },
  mediaTopRow: {
    position: 'absolute',
    top: 14,
    left: 14,
    right: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  kicker: {
    flexShrink: 1,
    color: colors.text,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.44)',
  },
  body: {
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 18,
  },
  metaRow: {
    minHeight: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  badge: {
    color: colors.onPrimary,
    backgroundColor: colors.primary,
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 11,
    fontWeight: '800',
  },
  meta: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.heading,
    fontSize: 26,
    lineHeight: 31,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 7,
  },
  subtitleAction: {
    color: colors.swarm,
  },
  signalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  signal: {
    color: colors.textMuted,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  signalActive: {
    color: colors.primary,
    borderWidth: 1,
    borderColor: 'rgba(163,230,53,0.35)',
    backgroundColor: 'rgba(163,230,53,0.10)',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  signalWarn: {
    color: '#fde68a',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.32)',
    backgroundColor: 'rgba(251,191,36,0.10)',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  playButton: {
    alignSelf: 'flex-start',
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: 999,
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  playText: {
    color: colors.onPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
})
