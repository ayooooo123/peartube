import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import type { MediaCockpitItem } from './HeroFeatureCard'

function asArray(value: unknown): Array<any> {
  return Array.isArray(value) ? value : []
}

function pickString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function sourceKey(source: any, index: number): string {
  const parts = [
    source?.publicationId,
    source?.renditionId,
    source?.playbackKey,
    source?.id,
    source?.videoId,
    source?.path,
  ].filter((value) => typeof value === 'string' && value.trim().length > 0)
  return parts.length > 0 ? parts.join(':') : `source-${index}`
}

function sourceLabel(source: any, index: number): string {
  return pickString(source?.publisherName, source?.sourceProviderName, source?.channelName, source?.publisherId, source?.channelKey, `Source ${index + 1}`) || `Source ${index + 1}`
}

function sourceStatus(source: any): string {
  const status = pickString(source?.archiveStatus, source?.availabilityStatus, source?.retentionStatus)
  if (source?.localComplete || status === 'local' || status === 'complete-local') return 'local'
  if (source?.cached || status === 'cached' || status === 'retained') return 'cached'
  if (source?.available || status === 'available' || status === 'online') return 'available'
  if (status) return status
  return 'claim'
}

export interface SourceSelectorProps {
  item: MediaCockpitItem & Record<string, any>
  onSelectSource?: (source: any) => void
}

function SourceSelectorComponent({ item, onSelectSource }: SourceSelectorProps) {
  const selectedSource = item?.selectedSource || item?.item?.selectedSource || null
  const alternateSources = asArray(item?.alternateSources)
  const allSources = asArray(item?.sources)
  const sources = allSources.length > 0
    ? allSources
    : [selectedSource, ...alternateSources].filter(Boolean)

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Source selector</Text>
          <Text style={styles.title}>Playable publications and renditions</Text>
        </View>
        <Text style={styles.count}>{sources.length} source{sources.length === 1 ? '' : 's'}</Text>
      </View>
      <View style={styles.list}>
        {sources.length === 0 ? (
          <Text style={styles.empty}>No alternate sources are attached yet. PearTube will use the legacy playable item if available.</Text>
        ) : sources.slice(0, 8).map((source, index) => {
          const selected = selectedSource && sourceKey(source, index) === sourceKey(selectedSource, index)
          return (
            <Pressable
              key={sourceKey(source, index)}
              onPress={() => onSelectSource?.(source)}
              accessibilityRole="button"
              accessibilityLabel={`Select ${sourceLabel(source, index)}`}
              style={[styles.row, selected ? styles.rowSelected : null]}
            >
              <View style={[styles.radio, selected ? styles.radioSelected : null]}>
                {selected ? <Ionicons name="checkmark" size={13} color={colors.onPrimary} /> : null}
              </View>
              <View style={styles.rowCopy}>
                <Text style={styles.rowTitle} numberOfLines={1}>{sourceLabel(source, index)}</Text>
                <Text style={styles.rowDetail} numberOfLines={1}>{pickString(source?.publicationId, source?.renditionId, source?.videoId, source?.path) || 'publication claim'}</Text>
              </View>
              <Text style={styles.status}>{sourceStatus(source)}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

export const SourceSelector = memo(SourceSelectorComponent)

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.bgElevated,
    padding: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  kicker: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.text,
    fontFamily: fonts.headingMedium,
    fontSize: 16,
    marginTop: 3,
  },
  count: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  list: {
    gap: 9,
    marginTop: 14,
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowSelected: {
    borderColor: 'rgba(163,230,53,0.34)',
    backgroundColor: 'rgba(163,230,53,0.08)',
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  rowCopy: {
    flex: 1,
  },
  rowTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
  },
  rowDetail: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  status: {
    color: colors.primary,
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(163,230,53,0.26)',
    backgroundColor: 'rgba(163,230,53,0.08)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 10,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
})
