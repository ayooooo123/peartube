import type { ReactElement } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, radius, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import type { MediaCockpitItem } from './HeroFeatureCard'
import {
  normalizeSourceExplanation,
  type PublicationSource,
} from './SourceExplanation'
import { isMediaSourcePlayable } from '../../lib/media-source-selection.js'

export { normalizeSourceExplanation }
export type { PublicationSource }

type SourceRecord = PublicationSource & {
  publisherName?: string | null
  sourceProviderName?: string | null
  channelName?: string | null
  channelKey?: string | null
  playbackKey?: string | null
  id?: string | null
  videoId?: string | null
  path?: string | null
  archiveStatus?: string | null
  availabilityStatus?: string | null
  retentionStatus?: string | null
  localComplete?: boolean | null
  cached?: boolean | null
  available?: boolean | null
}

type MediaSourceContainer = {
  selectedSource?: SourceRecord | null
  alternateSources?: SourceRecord[] | null
  sources?: SourceRecord[] | null
  item?: { selectedSource?: SourceRecord | null } | null
}

export type GraphSourceSelectorProps = {
  entityId: string
  sources?: PublicationSource[]
  selectedPublicationId?: string | null
  onSelectSource?: (source: { entityId: string; publicationId: string; renditionId: string }) => void
}

export type CockpitSourceSelectorProps = {
  item: MediaCockpitItem & MediaSourceContainer
  onSelectSource?: (source: SourceRecord) => void
}

export type SourceSelectorProps = GraphSourceSelectorProps | CockpitSourceSelectorProps

function isCockpitProps(props: SourceSelectorProps): props is CockpitSourceSelectorProps {
  return 'item' in props
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function sourceKey(source: SourceRecord, index: number): string {
  const parts = [
    source.publicationId,
    source.renditionId,
    source.playbackKey,
    source.id,
    source.videoId,
    source.path,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return parts.length > 0 ? parts.join(':') : `source-${index}`
}


function sourceStatus(source: SourceRecord): string {
  const status = pickString(
    source.archiveState,
    source.cacheState,
    source.availabilityState,
    source.archiveStatus,
    source.availabilityStatus,
    source.retentionStatus,
  )
  if (source.localComplete || status === 'local' || status === 'complete-local') return 'local'
  if (source.cached || status === 'cached' || status === 'retained') return 'cached'
  if (source.available || status === 'available' || status === 'online') return 'available'
  return status || 'claim'
}

export function isPublicationSourceSelectable(source: PublicationSource | null | undefined): boolean {
  return isMediaSourcePlayable(source || {})
}

// The backend ships one authoritative selection and the picker only reports it.
// Nothing here re-ranks: an explicit `selectedPublicationId` (or the cockpit's
// resolved source) is the viewer's own override, and otherwise the backend's
// `selected` verdict stands.
function matchesSelection(
  source: SourceRecord,
  index: number,
  cockpitSelection: SourceRecord | null,
  requestedPublicationId: string | null,
  cockpit: boolean,
): boolean {
  if (cockpit) {
    return cockpitSelection !== null
      ? sourceKey(source, index) === sourceKey(cockpitSelection, index)
      : source.selected === true
  }
  return requestedPublicationId !== null
    ? source.publicationId === requestedPublicationId
    : source.selected === true
}

export function SourceSelector(props: GraphSourceSelectorProps): ReactElement
export function SourceSelector(props: CockpitSourceSelectorProps): ReactElement
export function SourceSelector(props: SourceSelectorProps): ReactElement {
  const cockpit = isCockpitProps(props)
  const selectedSource = cockpit
    ? props.item.selectedSource || props.item.item?.selectedSource || null
    : null
  const itemSources = cockpit && Array.isArray(props.item.sources) ? props.item.sources : []
  const alternateSources = cockpit && Array.isArray(props.item.alternateSources) ? props.item.alternateSources : []
  const sources: SourceRecord[] = cockpit
    ? itemSources.length > 0
      ? itemSources
      : [selectedSource, ...alternateSources].filter((source): source is SourceRecord => source !== null)
    : props.sources || []
  const requestedPublicationId = cockpit ? null : props.selectedPublicationId ?? null
  const hasSelectedSource = sources.some((source, index) => (
    isPublicationSourceSelectable(source) &&
    matchesSelection(source, index, selectedSource, requestedPublicationId, cockpit)
  ))

  return (
    <View accessibilityLabel="Playback sources" style={styles.card}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.kicker}>Source selector</Text>
          <Text style={styles.title}>Playable publications and renditions</Text>
        </View>
        <Text style={styles.count}>{sources.length} source{sources.length === 1 ? '' : 's'}</Text>
      </View>
      {sources.length === 0 ? (
        <Text style={styles.empty}>No publication sources are known for this resolved media entity.</Text>
      ) : !hasSelectedSource ? (
        <Text style={styles.empty}>No trusted playable source is currently available. Rejected sources remain visible with local reasons.</Text>
      ) : null}
      <View style={styles.list}>
        {sources.slice(0, 8).map((source, index) => {
          const selectable = isPublicationSourceSelectable(source)
          const selected = selectable &&
            matchesSelection(source, index, selectedSource, requestedPublicationId, cockpit)
          // A source the backend ruled out before ranking stays on screen and
          // stays unpressable, so the viewer can see why it lost instead of
          // watching it vanish.
          const hardGated = source.eligible === false
          const explanation = normalizeSourceExplanation(source, index, selected)
          const onPress = selected || !selectable || !props.onSelectSource
            ? undefined
            : () => {
                if (isCockpitProps(props)) {
                  props.onSelectSource?.(source)
                } else {
                  props.onSelectSource?.({
                    entityId: props.entityId,
                    publicationId: source.publicationId,
                    renditionId: source.renditionId,
                  })
                }
              }
          const evidence = [
            explanation.reason,
            explanation.introduction,
            explanation.moderation,
            explanation.conflict,
            explanation.provenance,
            explanation.archive,
            explanation.cache,
            explanation.availability,
            explanation.offline,
            explanation.completeness,
          ]

          return (
            <Pressable
              key={sourceKey(source, index)}
              onPress={onPress}
              disabled={!onPress}
              accessibilityRole="button"
              accessibilityLabel={`${selected ? 'Selected' : selectable ? 'Use' : 'Unavailable'} source ${index + 1}`}
              accessibilityState={{ disabled: !onPress, selected }}
              style={[styles.row, selected ? styles.rowSelected : null]}
            >
              <View style={styles.rowHeading}>
                <View style={[styles.radio, selected ? styles.radioSelected : null]}>
                  {selected ? <Ionicons name="checkmark" size={13} color={colors.onPrimary} /> : null}
                </View>
                <View style={styles.rowCopy}>
                  <Text style={styles.rowTitle} numberOfLines={1}>Source {index + 1}</Text>
                </View>
                <Text style={[styles.status, !selectable && styles.statusUnavailable]}>
                  {selected ? 'selected' : selectable ? sourceStatus(source) : hardGated ? 'cannot play' : 'unavailable'}
                </Text>
              </View>
              <View style={styles.evidence}>
                {evidence.map((line, evidenceIndex) => (
                  <Text key={`${sourceKey(source, index)}:evidence:${evidenceIndex}`} style={styles.evidenceText}>{line}</Text>
                ))}
              </View>
              <Text style={[styles.action, !onPress && styles.actionDisabled]}>
                {selected
                  ? 'Currently selected'
                  : selectable
                    ? 'Use this source'
                    : hardGated
                      ? 'Cannot play on this device'
                      : 'Source unavailable'}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.card,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.lg,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  headerCopy: { flex: 1 },
  kicker: { ...fonts.caption.sm, color: colors.primary },
  title: { ...fonts.title.md, color: colors.text, marginTop: 3 },
  count: { ...fonts.caption.sm, color: colors.textMuted },
  empty: { ...fonts.body.sm, color: colors.textMuted, marginTop: spacing.md },
  list: { gap: spacing.sm, marginTop: spacing.md },
  row: {
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    borderRadius: radius.card,
    padding: spacing.md,
    gap: spacing.sm + 2,
  },
  rowSelected: {
    borderColor: colors.primary,
  },
  rowHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: radius.sm,
    borderWidth: borderWidth.rule,
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: { borderColor: colors.primary, backgroundColor: colors.primary },
  rowCopy: { flex: 1 },
  rowTitle: { ...fonts.title.md, fontSize: 14, lineHeight: 18, color: colors.text },
  rowId: { ...fonts.meta.xs, color: colors.textMuted, marginTop: 2 },
  status: {
    ...fonts.caption.sm,
    fontSize: 10,
    lineHeight: 12,
    color: colors.primary,
    borderRadius: radius.sm,
    overflow: 'hidden',
    borderWidth: borderWidth.hairline,
    borderColor: colors.primary,
    paddingHorizontal: spacing.sm - 2,
    paddingVertical: 3,
  },
  statusUnavailable: { color: colors.textMuted, borderColor: colors.border },
  evidence: { gap: 3, paddingLeft: 30 },
  evidenceText: { ...fonts.body.sm, fontSize: 12, lineHeight: 17, color: colors.textMuted },
  action: { ...fonts.caption.sm, color: colors.primary, paddingLeft: 30 },
  actionDisabled: { color: colors.textMuted },
})
