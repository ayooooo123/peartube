import { useEffect, useMemo, useState } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { LinearGradient } from 'expo-linear-gradient'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { colors, radius, spacing } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { describeAvailability } from '@/lib/media-availability'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { usePosterArtwork } from '@/hooks/usePosterArtwork'
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
  primaryAction?: {
    label: string
    disabled?: boolean
    status?: string | null
    onPress(): void
  }
  retentionChoice?: {
    value: 'contribution-cache' | 'archive-pin'
    onChange(value: 'contribution-cache' | 'archive-pin'): void
  }
  availabilityOverride?: {
    label: string
    detail: string
    playable: boolean
  }
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

/**
 * Year, runtime, genres, ratings and certification, as published on the claim.
 * A consumer cannot look any of it up, so each of these reads straight off the
 * swarm payload and its row simply disappears when the publisher never
 * claimed it — nothing here is fetched from a service.
 */
function mediaGenres(item: Record<string, any> | null | undefined): string[] {
  const genres = item?.genres
  return Array.isArray(genres)
    ? genres.filter((genre): genre is string => typeof genre === 'string' && genre.trim().length > 0).slice(0, 4)
    : []
}

function releaseYear(item: Record<string, any> | null | undefined): number | null {
  const year = item?.releaseYear
  return typeof year === 'number' && year > 0 ? year : null
}

/**
 * Runtime as a viewer reads it. The publisher's claimed minutes win; a
 * rendition that carries its own duration covers the titles without a claim.
 */
function runtimeLabel(item: Record<string, any> | null | undefined): string | null {
  const claimed = item?.runtimeMinutes
  const seconds = typeof item?.duration === 'number' && item.duration > 0
    ? item.duration
    : typeof item?.durationSec === 'number' && item.durationSec > 0
      ? item.durationSec
      : 0
  const runtime = typeof claimed === 'number' && claimed > 0 ? claimed : Math.round(seconds / 60)
  if (runtime <= 0) return null
  const hours = Math.floor(runtime / 60)
  const minutes = runtime % 60
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

function ratingText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.round(value * 10) / 10)
  return pickString(value)
}

function claimedRatings(item: Record<string, any> | null | undefined): Array<{ label: string; value: string }> {
  return asArray(item?.ratings)
    .map((entry) => {
      const value = ratingText(entry?.value ?? entry?.score ?? entry?.rating)
      if (!value) return null
      return { label: pickString(entry?.source, entry?.provider, entry?.label) || 'Rating', value }
    })
    .filter((entry): entry is { label: string; value: string } => entry !== null)
    .slice(0, 3)
}

/** Lines of overview shown before the reader asks for the rest. */
const OVERVIEW_LINES = 4

/**
 * Room the backdrop gets above the metadata panel, so the artwork reads as a
 * full-bleed hero rather than a strip behind the title.
 */
const HERO_SPACER_HEIGHT = 200

/**
 * Touch surfaces clamp the overview and reveal the rest on tap. The two hidden
 * copies measure the clamped and full heights, so the toggle only appears when
 * there is genuinely more text behind it.
 */
function ExpandableOverview({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const [clampedHeight, setClampedHeight] = useState(0)
  const [fullHeight, setFullHeight] = useState(0)
  const overflows = clampedHeight > 0 && fullHeight > clampedHeight + 1

  return (
    <Pressable
      accessibilityRole={overflows ? 'button' : undefined}
      accessibilityLabel={overflows ? (expanded ? 'Show less of the overview' : 'Show the full overview') : undefined}
      onPress={overflows ? () => setExpanded(open => !open) : undefined}
    >
      <Text
        style={[styles.overview, styles.overviewMeasure]}
        numberOfLines={OVERVIEW_LINES}
        onLayout={(event) => {
          // Android fires onLayout on these offscreen measurers with a null
          // layout, which threw and took the whole detail screen down to the
          // error boundary. No measurement is better than no screen.
          const height = event?.nativeEvent?.layout?.height
          if (height) setClampedHeight(current => current || height)
        }}
      >
        {text}
      </Text>
      <Text
        style={[styles.overview, styles.overviewMeasure]}
        onLayout={(event) => {
          const height = event?.nativeEvent?.layout?.height
          if (height) setFullHeight(current => current || height)
        }}
      >
        {text}
      </Text>
      <Text style={styles.overview} numberOfLines={expanded ? undefined : OVERVIEW_LINES}>{text}</Text>
      {overflows ? <Text style={styles.overviewToggle}>{expanded ? 'Show less' : 'More'}</Text> : null}
    </Pressable>
  )
}

export function MediaEntityDetailScreen({
  type,
  routeId: routeIdProp,
  itemParam,
  publisherDeviceStatus,
  publisherActionHandlers,
  onSelectSource,
  onPlay,
  primaryAction,
  retentionChoice,
  availabilityOverride,
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
  // Same treatment the home rails give a poster: a blob-claimed cover resolves
  // through the local blob server, and only older origin claims render flat.
  const artwork = usePosterArtwork(item, pickString(item?.backdropUrl, item?.posterUrl, item?.stillUrl, item?.thumbnailUrl, item?.thumbnail))
  const sourceCount = typeof item?.sourceCount === 'number' ? item.sourceCount : Array.isArray(item?.sources) ? item.sources.length : 0
  const synopsis = pickString(item?.synopsis, item?.description, item?.overview)
  // One availability answer for the whole screen, from the same assessment the
  // card quoted; the hero shows it plainly and Other Sources explains it.
  const availabilityView = availabilityOverride || describeAvailability(
    item?.availability ?? asArray(item?.sources).find((source) => source?.selected)?.availability ?? null,
  )
  const genres = mediaGenres(item)
  const year = releaseYear(item)
  const runtime = runtimeLabel(item)
  const ratings = claimedRatings(item)
  const certification = pickString(item?.certification, item?.contentRating, item?.ageRating)
  // Watch progress is device-local, so the primary action can offer to resume
  // without asking anything of the swarm.
  const progressPercent = typeof resumeFraction === 'number' && resumeFraction > 0
    ? Math.min(99, Math.max(1, Math.round(resumeFraction * 100)))
    : null
  const playLabel = primaryAction?.label || (progressPercent === null ? 'Watch Now' : 'Resume')
  const actionDisabled = primaryAction?.disabled ?? !availabilityView.playable
  const detailsLabel = detailsOpen
    ? 'Hide details'
    : `Details and other sources${sourceCount > 1 ? ` (${sourceCount})` : ''}`

  return (
    <View style={styles.root}>
      {/* The artwork sits full-bleed behind everything at a third of its
          strength, and a gradient carries it down into the base colour over
          the lower two thirds of the screen. */}
      <View style={styles.backdrop}>
        {artwork ? (
          <View style={styles.backdropArtwork}>
            <ThumbnailImage
              thumbnailUrl={artwork}
              channelInitial={title.charAt(0).toUpperCase()}
              style={styles.backdropImage}
            />
          </View>
        ) : null}
        <LinearGradient
          colors={['transparent', colors.scrim, colors.bg]}
          locations={[0, 0.7, 1]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={styles.heroFade}
        />
        <LinearGradient
          colors={['transparent', colors.scrim, colors.bg]}
          locations={[0, 0.7, 1]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={styles.screenFade}
        />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Pressable onPress={onBack || (() => router.back())} accessibilityRole="button" accessibilityLabel="Go back" style={styles.backButton}>
          <Ionicons name="chevron-back" color={colors.text} size={18} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>

        <View style={styles.heroSpacer} />

        <View style={styles.panel}>
          <Text style={styles.kicker}>{pageTitleFor(type)}</Text>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.byline}>{subtitle}</Text> : null}

          {ratings.length > 0 ? (
            <View style={styles.badgeRow}>
              {ratings.map((rating) => (
                <View key={rating.label} style={styles.ratingBadge}>
                  <Ionicons name="star" color={colors.accentSecondary} size={12} />
                  <Text style={styles.ratingValue}>{rating.value}</Text>
                  <Text style={styles.ratingLabel}>{rating.label}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {certification || genres.length > 0 ? (
            <View style={styles.badgeRow}>
              {certification ? (
                <View style={styles.badge}><Text style={styles.badgeText}>{certification}</Text></View>
              ) : null}
              {certification && genres.length > 0 ? <Text style={styles.badgeSeparator}>|</Text> : null}
              {genres.map((genre) => (
                <View key={genre} style={styles.badge}><Text style={styles.badgeText}>{genre}</Text></View>
              ))}
            </View>
          ) : null}

          {year !== null || runtime ? (
            <View style={styles.releaseRow}>
              {year !== null ? (
                <View style={styles.releaseItem}>
                  <Ionicons name="calendar-outline" color={colors.textSecondary} size={14} style={styles.releaseIcon} />
                  <Text style={styles.releaseValue}>{String(year)}</Text>
                </View>
              ) : null}
              {runtime ? (
                <View style={styles.releaseItem}>
                  <Ionicons name="time-outline" color={colors.textSecondary} size={14} style={styles.releaseIcon} />
                  <Text style={styles.releaseValue}>{runtime}</Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {synopsis
            ? Platform.OS === 'web'
              ? <Text style={styles.overview}>{synopsis}</Text>
              : <ExpandableOverview text={synopsis} />
            : null}

          <Text
            style={[styles.availability, !availabilityView.playable && styles.availabilityMuted]}
            accessibilityLabel={`Availability: ${availabilityView.label}. ${availabilityView.detail}`}
          >
            {availabilityView.label}
          </Text>

          {retentionChoice ? (
            <View style={styles.retentionChoices}>
              {([
                ['contribution-cache', 'Stream once'],
                ['archive-pin', 'Keep after watching'],
              ] as const).map(([value, label]) => (
                <Pressable
                  key={value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: retentionChoice.value === value }}
                  onPress={() => retentionChoice.onChange(value)}
                  style={[
                    styles.retentionChoice,
                    retentionChoice.value === value && styles.retentionChoiceSelected,
                  ]}
                >
                  <Text style={styles.secondaryActionLabel}>{label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {/* One tap plays. The backend already picked the source and fails
              over, so nothing stands between this button and playback; the
              per-source diagnostics live behind the disclosure beside it. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.actionRow}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${playLabel} ${title}`}
              accessibilityState={{ disabled: actionDisabled }}
              disabled={actionDisabled}
              onPress={() => primaryAction ? primaryAction.onPress() : onPlay?.()}
              style={({ pressed }) => [
                styles.primaryAction,
                actionDisabled && styles.actionDisabled,
                pressed && styles.actionPressed,
              ]}
            >
              <View style={styles.actionContent}>
                <Ionicons name="play" color={colors.onPrimary} size={20} />
                <Text style={styles.primaryActionLabel} numberOfLines={1}>{playLabel}</Text>
              </View>
            </Pressable>

            {progressPercent === null ? null : (
              <View style={styles.progressPill}>
                <Text style={styles.progressText}>{`${progressPercent}%`}</Text>
              </View>
            )}

            {/* Consumer surface ends here. Everything behind this disclosure is
                operational detail a viewer opens deliberately: source
                diagnostics, archive mechanics, provenance, publisher state. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={detailsOpen ? 'Hide details and other sources' : 'Show details and other sources'}
              accessibilityState={{ expanded: detailsOpen }}
              onPress={() => setDetailsOpen(open => !open)}
              style={({ pressed }) => [styles.secondaryAction, pressed && styles.actionPressed]}
            >
              <View style={styles.actionContent}>
                <Text style={styles.secondaryActionLabel} numberOfLines={1}>{detailsLabel}</Text>
                <Ionicons name={detailsOpen ? 'chevron-up' : 'chevron-down'} color={colors.textSecondary} size={16} />
              </View>
            </Pressable>
          </ScrollView>
          {primaryAction?.status ? <Text style={styles.availabilityDetail}>{primaryAction.status}</Text> : null}

          {availabilityView.playable ? null : (
            <Text style={styles.availabilityDetail}>{availabilityView.detail}</Text>
          )}
        </View>

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

// React Native 0.85 dropped `StyleSheet.absoluteFillObject`, and its
// `absoluteFill` is a compiled handle on web rather than a plain object, so
// the overlay geometry is spelled out once here and spread where needed.
const ABSOLUTE_FILL = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  backdrop: {
    ...ABSOLUTE_FILL,
    overflow: 'hidden',
    pointerEvents: 'none',
  },
  backdropArtwork: {
    ...ABSOLUTE_FILL,
    opacity: 0.3,
  },
  // ThumbnailImage is 16:9 by default; the backdrop fills whatever the screen is.
  backdropImage: {
    width: '100%',
    height: '100%',
    aspectRatio: undefined,
    borderRadius: radius.none,
  },
  heroFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '65%',
  },
  screenFade: {
    ...ABSOLUTE_FILL,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  heroSpacer: {
    height: HERO_SPACER_HEIGHT,
  },
  backButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    backgroundColor: colors.overlayButton,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  backText: {
    ...fonts.label.md,
    color: colors.text,
  },
  panel: {
    backgroundColor: colors.scrim,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.overlayMedium,
    padding: spacing.lg,
    gap: spacing.md,
  },
  kicker: {
    ...fonts.caption.sm,
    color: colors.primary,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  title: {
    ...fonts.title.lg,
    fontFamily: fonts.heading,
    color: colors.text,
  },
  byline: {
    ...fonts.body.sm,
    color: colors.textSecondary,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
  },
  ratingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.overlayMedium,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  ratingValue: {
    ...fonts.body.sm,
    fontWeight: '700',
    color: colors.text,
  },
  ratingLabel: {
    ...fonts.caption.sm,
    color: colors.textSecondary,
  },
  badge: {
    backgroundColor: colors.overlayMedium,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    borderRadius: radius.xl,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  badgeText: {
    ...fonts.caption.sm,
    color: colors.textSecondary,
  },
  badgeSeparator: {
    ...fonts.body.sm,
    fontWeight: '900',
    color: colors.textSecondary,
  },
  releaseRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.lg,
  },
  releaseItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  releaseIcon: {
    marginRight: spacing.xs,
  },
  releaseValue: {
    ...fonts.body.sm,
    color: colors.textSecondary,
  },
  overview: {
    ...fonts.body.md,
    color: colors.textSecondary,
  },
  // Measurement copies: laid out, never seen.
  overviewMeasure: {
    position: 'absolute',
    opacity: 0,
    zIndex: -1,
  },
  overviewToggle: {
    ...fonts.body.sm,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  availability: {
    ...fonts.label.md,
    color: colors.primary,
  },
  availabilityMuted: {
    color: colors.textMuted,
  },
  availabilityDetail: {
    ...fonts.body.sm,
    color: colors.textMuted,
  },
  retentionChoices: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  retentionChoice: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  retentionChoiceSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.overlayButton,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingRight: spacing.xs,
  },
  // Accent blue, taller and wider than anything beside it: the one thing on
  // this screen a viewer is meant to press.
  actionContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: spacing.sm,
  },
  primaryAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    flexShrink: 0,
    minHeight: 52,
    paddingHorizontal: spacing.xxl,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  primaryActionLabel: {
    ...fonts.label.md,
    fontFamily: fonts.headingMedium,
    color: colors.onPrimary,
  },
  secondaryAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 0,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.overlayButton,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  secondaryActionLabel: {
    ...fonts.body.sm,
    color: colors.text,
  },
  actionDisabled: {
    opacity: 0.45,
  },
  actionPressed: {
    opacity: 0.8,
  },
  progressPill: {
    flexShrink: 0,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.overlayMedium,
  },
  progressText: {
    ...fonts.caption.sm,
    color: colors.textSecondary,
  },
  panels: {
    gap: spacing.md,
  },
  detailCard: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgElevated,
    padding: spacing.lg,
  },
  detailTitle: {
    ...fonts.title.md,
    fontFamily: fonts.headingMedium,
    color: colors.text,
    marginTop: spacing.xs,
  },
  summaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  summaryPill: {
    ...fonts.caption.sm,
    color: colors.primary,
    borderRadius: radius.pill,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.primaryLight,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    textTransform: 'uppercase',
  },
  mutedPill: {
    ...fonts.caption.sm,
    color: colors.textMuted,
    borderRadius: radius.pill,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.overlayMedium,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    textTransform: 'uppercase',
  },
  subsection: {
    marginTop: spacing.md,
    gap: spacing.xs,
  },
  detailLabel: {
    ...fonts.caption.sm,
    color: colors.text,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  detailLine: {
    ...fonts.body.sm,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  detailMuted: {
    ...fonts.body.sm,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
})
