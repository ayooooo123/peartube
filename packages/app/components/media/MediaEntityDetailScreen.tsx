import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { describeAvailability } from '@/lib/media-availability'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { ArchiveStatus } from './ArchiveStatus'
import { ConflictNotice } from './ConflictNotice'
import { ProvenancePanel } from './ProvenancePanel'
import { SourceSelector } from './SourceSelector'
import type { MediaCockpitItem } from './HeroFeatureCard'
import {
  PublisherDeviceStatus,
  type PublisherCapabilityAction,
  type PublisherDeviceStatusInput,
} from '@/components/publisher/PublisherDeviceStatus'

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function decodeMaybe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function decodeItem(value: string | string[] | undefined): (MediaCockpitItem & Record<string, any>) | null {
  const raw = firstParam(value)
  if (!raw) return null
  try {
    const parsed = JSON.parse(decodeMaybe(raw))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function asArray(value: unknown): Array<any> {
  return Array.isArray(value) ? value : []
}

function pickString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function sourceIdentityKey(source: any): string {
  return [
    source?.publicationId,
    source?.renditionId,
    source?.playbackKey,
    source?.id,
    source?.videoId,
    source?.path,
  ].filter((value) => typeof value === 'string' && value.trim().length > 0).join(':')
}

function candidateSourcesForItem(item: Record<string, any>): Array<any> {
  const sources = asArray(item.sources)
  if (sources.length > 0) return sources
  return [item.selectedSource, ...asArray(item.alternateSources)].filter((source) => source && typeof source === 'object' && !Array.isArray(source))
}

function pageTitleFor(type: MediaEntityDetailType): string {
  if (type === 'collection') return 'Collection'
  if (type === 'creator') return 'Creator'
  return 'Media work'
}

function routeFallbackTitle(type: MediaEntityDetailType, id: string | undefined): string {
  const label = pageTitleFor(type)
  return id ? `${label} ${decodeMaybe(id)}` : label
}

function fallbackItemForRoute(type: MediaEntityDetailType, routeId: string | undefined): MediaCockpitItem & Record<string, any> {
  const decodedId = routeId ? decodeMaybe(routeId) : `${type}:unresolved`
  return {
    id: decodedId,
    localEntityId: decodedId,
    entityKind: type === 'creator' ? 'agent' : type,
    contentKind: type,
    title: routeFallbackTitle(type, routeId),
    subtitle: 'Resolver id available; full media graph payload has not been hydrated in this route yet.',
    sourceCount: 0,
    sources: [],
    alternateSources: [],
    provenance: [{ role: 'route-resolver-id', entityId: decodedId }],
    conflicts: [],
    items: [],
    missingMembers: [],
    contributions: [],
    completeness: type === 'collection' ? { known: 0, missing: 0, hasTrustedStructure: false } : null,
    item: { localEntityId: decodedId, entityKind: type, resolverPending: true },
  }
}

function applySelectedSource(item: MediaCockpitItem & Record<string, any>, selectedSource: any | null): MediaCockpitItem & Record<string, any> {
  if (!selectedSource) return item
  const sources = candidateSourcesForItem(item)
  const selectedKey = sourceIdentityKey(selectedSource)
  const alternateSources = sources.filter((source) => sourceIdentityKey(source) !== selectedKey)
  const sourceProviderName = pickString(selectedSource.sourceProviderName, selectedSource.publisherName, selectedSource.channelName, item.sourceProviderName, item.publisherName)
  return {
    ...item,
    selectedSource,
    alternateSources,
    sourceProviderName,
    publisherName: sourceProviderName || item.publisherName,
    channelKey: pickString(selectedSource.channelKey, selectedSource.publisherId, item.channelKey),
    driveKey: pickString(selectedSource.driveKey, selectedSource.channelKey, item.driveKey),
    videoId: pickString(selectedSource.videoId, selectedSource.publicationId, item.videoId),
    path: pickString(selectedSource.path, item.path),
    publicBeeKey: pickString(selectedSource.publicBeeKey, item.publicBeeKey),
    publicationId: pickString(selectedSource.publicationId, item.publicationId),
    renditionId: pickString(selectedSource.renditionId, item.renditionId),
    playbackKey: pickString(selectedSource.playbackKey, item.playbackKey),
    archiveStatus: pickString(selectedSource.archiveStatus, selectedSource.retentionStatus, item.archiveStatus),
    availabilityStatus: pickString(selectedSource.availabilityStatus, item.availabilityStatus),
    item: { ...item.item, selectedSource, alternateSources },
  }
}

function CollectionStructurePanel({ item }: { item: Record<string, any> }) {
  const members = asArray(item.items || item.members || item.collectionItems)
  const missingMembers = asArray(item.missingMembers || item.missingSlots)
  const completeness = item.completeness && typeof item.completeness === 'object' ? item.completeness : {}
  return (
    <View style={styles.detailCard}>
      <Text style={styles.kicker}>Collection structure</Text>
      <Text style={styles.detailTitle}>Known works, missing slots, and completeness</Text>
      <View style={styles.summaryRow}>
        <Text style={styles.summaryPill}>{members.length} known</Text>
        <Text style={styles.summaryPill}>{missingMembers.length} missing</Text>
        <Text style={completeness.hasTrustedStructure ? styles.summaryPill : styles.mutedPill}>{completeness.hasTrustedStructure ? 'trusted structure' : 'untrusted structure'}</Text>
      </View>
      {members.length > 0 ? members.slice(0, 6).map((member, index) => (
        <Text key={`member-${index}`} style={styles.detailLine} numberOfLines={1}>{pickString(member?.title, member?.name, member?.workId, member?.id, `Member ${index + 1}`)}</Text>
      )) : <Text style={styles.detailMuted}>No member claims are attached to this collection payload.</Text>}
      {missingMembers.length > 0 ? (
        <View style={styles.subsection}>
          <Text style={styles.detailLabel}>Missing member claims</Text>
          {missingMembers.slice(0, 6).map((member, index) => (
            <Text key={`missing-${index}`} style={styles.detailLine} numberOfLines={1}>{pickString(member?.title, member?.reason, member?.workId, member?.id, `Missing slot ${index + 1}`)}</Text>
          ))}
        </View>
      ) : null}
    </View>
  )
}

function CreatorContributionsPanel({ item }: { item: Record<string, any> }) {
  const contributions = asArray(item.contributions || item.creatorRoles)
  return (
    <View style={styles.detailCard}>
      <Text style={styles.kicker}>Creator graph</Text>
      <Text style={styles.detailTitle}>Role attribution and publisher claims</Text>
      <View style={styles.summaryRow}>
        <Text style={styles.summaryPill}>{contributions.length} contribution{contributions.length === 1 ? '' : 's'}</Text>
        {typeof item.sourcePublisherCount === 'number' ? <Text style={styles.summaryPill}>{item.sourcePublisherCount} publisher{item.sourcePublisherCount === 1 ? '' : 's'}</Text> : null}
      </View>
      {contributions.length > 0 ? contributions.slice(0, 8).map((entry, index) => (
        <Text key={`contribution-${index}`} style={styles.detailLine} numberOfLines={1}>
          {pickString(entry?.role, 'creator')} · {pickString(entry?.name, entry?.agentId, entry?.publisherName, `Contributor ${index + 1}`)}
        </Text>
      )) : <Text style={styles.detailMuted}>No creator contribution claims are attached to this payload yet.</Text>}
    </View>
  )
}

export type MediaEntityDetailType = 'media' | 'collection' | 'creator'

export interface MediaEntityDetailScreenProps {
  type: MediaEntityDetailType
  routeId?: string
  itemParam?: string | string[]
  publisherDeviceStatus?: PublisherDeviceStatusInput | null
  publisherActionHandlers?: Partial<Record<PublisherCapabilityAction, () => void>>
  onSelectSource?: (source: { entityId: string; publicationId: string; renditionId: string }) => void
  /** One Play/Resume action. The backend chooses the source. */
  onPlay?: () => void
  /** Fraction watched on this device, when there is something to resume. */
  resumeFraction?: number | null
  /**
   * Open the details/Other Sources disclosure on first render. Consumers leave
   * this closed; deep links into source diagnostics set it.
   */
  initialDetailsOpen?: boolean
  onBack?: () => void
}

export function encodeMediaEntityRouteParam(item: MediaCockpitItem & Record<string, any>): string {
  return encodeURIComponent(JSON.stringify(item))
}

export function getMediaEntityRouteId(item: MediaCockpitItem & Record<string, any>): string {
  const selectedSource = item?.selectedSource || item?.item?.selectedSource || null
  return pickString(
    item?.localEntityId,
    item?.entityId,
    item?.id,
    item?.videoId,
    selectedSource?.publicationId,
    selectedSource?.renditionId,
    selectedSource?.videoId,
    selectedSource?.id,
    'entity',
  ) || 'entity'
}

export function MediaEntityDetailScreen({
  type,
  routeId: routeIdProp,
  itemParam,
  publisherDeviceStatus,
  publisherActionHandlers,
  onSelectSource,
  onPlay,
  resumeFraction = null,
  initialDetailsOpen = false,
  onBack,
}: MediaEntityDetailScreenProps) {
  const params = useLocalSearchParams()
  const router = useRouter()
  const routeId = routeIdProp || firstParam(params.id)
  const itemQueryParam = itemParam ?? params.item
  const decodedItem = useMemo(() => decodeItem(itemQueryParam), [itemQueryParam])
  const baseItem = useMemo(() => decodedItem || fallbackItemForRoute(type, routeId), [decodedItem, routeId, type])
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null)
  // Operational detail stays closed until a viewer deliberately opens it.
  const [detailsOpen, setDetailsOpen] = useState(initialDetailsOpen)

  useEffect(() => {
    setSelectedSourceKey(null)
  }, [params.item, routeId, type])

  const selectedOverride = useMemo(() => {
    if (!selectedSourceKey) return null
    return asArray(baseItem.sources).find((source) => sourceIdentityKey(source) === selectedSourceKey) || null
  }, [baseItem, selectedSourceKey])
  const item = useMemo(() => applySelectedSource(baseItem, selectedOverride), [baseItem, selectedOverride])
  const title = pickString(item?.title, item?.preferredMetadata?.title, item?.name, routeFallbackTitle(type, routeId)) || pageTitleFor(type)
  const subtitle = pickString(item?.subtitle, item?.creatorName, item?.sourceProviderName, item?.publisherName, item?.channelName, item?.channel?.name)
  const artwork = pickString(item?.backdropUrl, item?.posterUrl, item?.stillUrl, item?.thumbnailUrl, item?.thumbnail)
  const duration = typeof item?.duration === 'number' && item.duration > 0
    ? item.duration
    : typeof item?.durationSec === 'number' && item.durationSec > 0
      ? item.durationSec
      : undefined
  const sourceCount = typeof item?.sourceCount === 'number' ? item.sourceCount : Array.isArray(item?.sources) ? item.sources.length : 0
  const synopsis = pickString(item?.synopsis, item?.description, item?.overview)
  // One availability answer for the whole screen, from the same assessment the
  // card quoted; the hero shows it plainly and Other Sources explains it.
  const availabilityView = describeAvailability(
    item?.availability ?? asArray(item?.sources).find((source) => source?.selected)?.availability ?? null,
  )
  const playLabel = typeof resumeFraction === 'number' && resumeFraction > 0 ? 'Resume' : 'Play'

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Pressable onPress={onBack || (() => router.back())} accessibilityRole="button" accessibilityLabel="Go back" style={styles.backButton}>
          <Ionicons name="chevron-back" color={colors.text} size={18} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>

        <View style={styles.hero}>
          <View style={styles.artworkFrame}>
            <ThumbnailImage thumbnailUrl={artwork} duration={duration} channelInitial={title.charAt(0).toUpperCase()} style={styles.artwork} />
          </View>
          <View style={styles.heroCopy}>
            <Text style={styles.kicker}>{pageTitleFor(type)}</Text>
            <Text style={styles.title}>{title}</Text>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
            {synopsis ? <Text style={styles.synopsis} numberOfLines={4}>{synopsis}</Text> : null}
            <Text
              style={[styles.availability, !availabilityView.playable && styles.availabilityMuted]}
              accessibilityLabel={`Availability: ${availabilityView.label}. ${availabilityView.detail}`}
            >
              {availabilityView.label}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${playLabel} ${title}`}
              accessibilityState={{ disabled: !availabilityView.playable }}
              disabled={!availabilityView.playable}
              onPress={() => onPlay?.()}
              style={({ pressed }) => [
                styles.playButton,
                !availabilityView.playable && styles.playButtonDisabled,
                pressed && styles.playButtonPressed,
              ]}
            >
              <Ionicons name="play" color={colors.bg} size={18} />
              <Text style={styles.playLabel}>{playLabel}</Text>
            </Pressable>
            {availabilityView.playable ? null : (
              <Text style={styles.availabilityDetail}>{availabilityView.detail}</Text>
            )}
          </View>
        </View>

        {/* Consumer surface ends here. Everything below is operational detail
            a viewer opens deliberately: source diagnostics, archive mechanics,
            provenance, and publisher device state. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={detailsOpen ? 'Hide details and other sources' : 'Show details and other sources'}
          accessibilityState={{ expanded: detailsOpen }}
          onPress={() => setDetailsOpen(open => !open)}
          style={styles.detailsToggle}
        >
          <Text style={styles.detailsToggleLabel}>
            {detailsOpen ? 'Hide details' : `Details and other sources${sourceCount > 1 ? ` (${sourceCount})` : ''}`}
          </Text>
          <Ionicons name={detailsOpen ? 'chevron-up' : 'chevron-down'} color={colors.textMuted} size={16} />
        </Pressable>

        {!detailsOpen ? null : (
        <View style={styles.panels}>
          <ArchiveStatus item={item} />
          <ConflictNotice item={item} />
          <SourceSelector
            item={item}
            onSelectSource={(source) => {
              setSelectedSourceKey(sourceIdentityKey(source))
              if (onSelectSource) {
                onSelectSource({
                  entityId: pickString(item.entityId, item.localEntityId, routeId) || 'entity',
                  publicationId: pickString(source.publicationId) || '',
                  renditionId: pickString(source.renditionId) || '',
                })
              }
            }}
          />
          <ProvenancePanel item={item} />
          {publisherDeviceStatus || item.publisherDeviceStatus
            ? (
                <PublisherDeviceStatus
                  status={publisherDeviceStatus || item.publisherDeviceStatus}
                  actionHandlers={publisherActionHandlers}
                />
              )
            : null}
          {type === 'collection' ? <CollectionStructurePanel item={item} /> : null}
          {type !== 'collection' ? <CreatorContributionsPanel item={item} /> : null}
        </View>
        )}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  detailsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    marginTop: 24,
    paddingHorizontal: 4,
  },
  detailsToggleLabel: {
    color: colors.textMuted,
    fontFamily: fonts.headingMedium,
    fontSize: 13,
  },
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 40,
    gap: 18,
  },
  backButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.bgElevated,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  backText: {
    color: colors.text,
    fontWeight: '800',
  },
  hero: {
    borderRadius: 28,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.bgElevated,
  },
  artworkFrame: {
    height: 210,
    backgroundColor: colors.bgSecondary,
  },
  artwork: {
    width: '100%',
    height: '100%',
    borderRadius: 0,
  },
  heroCopy: {
    padding: 18,
  },
  kicker: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.text,
    fontFamily: fonts.heading,
    fontSize: 28,
    lineHeight: 33,
    marginTop: 8,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  synopsis: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 10,
  },
  availability: {
    color: colors.primary,
    fontFamily: fonts.headingMedium,
    fontSize: 13,
    marginTop: 12,
  },
  availabilityMuted: {
    color: colors.textMuted,
  },
  availabilityDetail: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 6,
  },
  playButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    minHeight: 44,
    paddingHorizontal: 22,
    borderRadius: 999,
    marginTop: 14,
    backgroundColor: colors.primary,
  },
  playButtonDisabled: {
    opacity: 0.45,
  },
  playButtonPressed: {
    opacity: 0.8,
  },
  playLabel: {
    color: colors.bg,
    fontFamily: fonts.headingMedium,
    fontSize: 15,
  },
  chip: {
    color: colors.primary,
    borderWidth: 1,
    borderColor: 'rgba(163,230,53,0.26)',
    backgroundColor: 'rgba(163,230,53,0.08)',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 9,
    paddingVertical: 5,
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  warnChip: {
    color: '#fde68a',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.28)',
    backgroundColor: 'rgba(251,191,36,0.10)',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 9,
    paddingVertical: 5,
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  panels: {
    gap: 14,
  },
  detailCard: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.bgElevated,
    padding: 16,
  },
  detailTitle: {
    color: colors.text,
    fontFamily: fonts.headingMedium,
    fontSize: 16,
    marginTop: 3,
  },
  summaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 13,
    marginBottom: 10,
  },
  summaryPill: {
    color: colors.primary,
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(163,230,53,0.26)',
    backgroundColor: 'rgba(163,230,53,0.08)',
    paddingHorizontal: 9,
    paddingVertical: 5,
    fontSize: 10,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  mutedPill: {
    color: colors.textMuted,
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: 'rgba(255,255,255,0.035)',
    paddingHorizontal: 9,
    paddingVertical: 5,
    fontSize: 10,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  subsection: {
    marginTop: 12,
    gap: 6,
  },
  detailLabel: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  detailLine: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5,
  },
  detailMuted: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
  },
})
