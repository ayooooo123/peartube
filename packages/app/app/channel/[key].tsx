import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  Modal,
  ScrollView,
  FlatList,
  Text,
  View,
  ActivityIndicator,
  Pressable,
  Image,
  StyleSheet,
  type PressableProps,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useApp } from '../_layout'
import { Feather } from '@expo/vector-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import * as ImagePicker from 'expo-image-picker'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { fetchThumbnailUrlWithRetry, type ThumbnailRPC } from '@/lib/thumbnail'
import { NativeButton, NativeTextInput } from '@/components/native-ui'
import { rpc } from '@peartube/platform/rpc'
import { Skeleton } from '@/components/ui/skeleton'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { formatContentBadge } from '@/lib/formatters'
import * as haptics from '@/lib/haptics'
import { withChannelPageTimeout } from '@/lib/channel-page'
import { createChannelCatalogState } from '@/lib/channel-catalog-state.js'
import { createChannelPlaybackPayload } from '@/lib/channel-playback-handoff.js'
import { CHANNEL_ARTWORK_RESOLUTION_MS, resolveArtworkCandidates } from '@/lib/channel-artwork.js'

type ChannelProfile = {
  name?: string
  description?: string | null
}

type ChannelVideo = {
  id: string
  title: string
  description?: string | null
  sourcePublishedAt?: number
  originalAirDate?: number
  thumbnailUrl?: string | null
  thumbnailBlobId?: string | null
  thumbnailBlobsCoreKey?: string | null
  thumbnailMimeType?: string | null
  blobId?: string | null
  blobsCoreKey?: string | null
  mimeType?: string | null
  publicBeeKey?: string | null
  duration?: number
  contentKind?: string | null
  seasonNumber?: number | null
  episodeNumber?: number | null
}


type ArtworkCandidate =
  | { kind: 'blob'; role: string; blobId: string; blobsCoreKey: string; mimeType: string | null }
  | { kind: 'remote'; role: string; url: string }

type CatalogCard = {
  id: string
  item: ChannelVideo
  artworkCandidates: ArtworkCandidate[]
  sectionLabel?: string
}

// TV channels: order episodes Season 1..N (episodes ascending inside) and stamp
// a `sectionLabel` on each season's first card so the list renders "Season N"
// headers. Channels without episode coordinates pass through untouched.
export function groupCardsBySeason (cards: CatalogCard[]): CatalogCard[] {
  const isEpisode = (card: CatalogCard) =>
    card.item?.contentKind === 'episode' &&
    Number(card.item?.seasonNumber) > 0 &&
    Number(card.item?.episodeNumber) > 0
  const episodes = cards.filter(isEpisode)
  if (episodes.length === 0) return cards

  const rest = cards.filter((card) => !isEpisode(card))
  const sorted = [...episodes].sort((a, b) =>
    (Number(a.item.seasonNumber) - Number(b.item.seasonNumber)) ||
    (Number(a.item.episodeNumber) - Number(b.item.episodeNumber)))

  let lastSeason: number | null = null
  const labeled = sorted.map((card) => {
    const season = Number(card.item.seasonNumber)
    const isFirstOfSeason = season !== lastSeason
    lastSeason = season
    return isFirstOfSeason ? { ...card, sectionLabel: `Season ${season}` } : card
  })
  return [...labeled, ...rest]
}
type ArtworkResolution = {
  url: string | null
  nextIndex: number
  provisional: boolean
  failedUrls: string[]
}


type CatalogTab = {
  id: string
  label: string
  sectionLabel: string
  itemCount: number
}

type CatalogView = {
  profile: ChannelProfile | null
  badge: string | null
  tabs: CatalogTab[]
  profileArtwork: {
    avatar: ArtworkCandidate[]
    banner: ArtworkCandidate[]
    card: ArtworkCandidate[]
  }
}

type GroupPageState = {
  cards: CatalogCard[]
  nextCursor: string | null
  loaded: boolean
  loading: boolean
  loadingMore: boolean
  error: string
}

type CatalogStateSnapshot = {
  catalog: CatalogView | null
  selectedGroupId: string
  pages: Record<string, GroupPageState>
  catalogLoading: boolean
  catalogError: string
}

const EMPTY_GROUP_PAGE: GroupPageState = {
  cards: [],
  nextCursor: null,
  loaded: false,
  loading: false,
  loadingMore: false,
  error: '',
}

const INITIAL_CATALOG_STATE: CatalogStateSnapshot = {
  catalog: null,
  selectedGroupId: '',
  pages: {},
  catalogLoading: true,
  catalogError: '',
}

function resolveRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || ''
  return value || ''
}

function buildChannelScreenPresentation(input: {
  catalogState: CatalogStateSnapshot
  channelKey: string
  identityDriveKey: string
  profileArtworkCache: Record<string, ArtworkResolution>
  avatarPreviewUrl: string
}) {
  const catalogView = input.catalogState.catalog
  const channelProfile = catalogView?.profile ?? null
  const selectedGroupId = input.catalogState.selectedGroupId
  const selectedTab = catalogView?.tabs.find((tab) => tab.id === selectedGroupId) ?? null
  const selectedPage = input.catalogState.pages[selectedGroupId] ?? EMPTY_GROUP_PAGE
  const mappedAvatarUrl = input.profileArtworkCache.avatar?.url ?? ''
  const activeAvatarUrl = input.avatarPreviewUrl || mappedAvatarUrl
  const bannerUrl = input.profileArtworkCache.banner?.url ?? ''
  const channelDisplayName = channelProfile?.name?.trim() || `Channel ${input.channelKey.slice(0, 8)}`
  const channelDescription = channelProfile?.description?.trim() || 'No channel description yet.'
  const selectedItemCount = selectedTab?.itemCount ?? selectedPage.cards.length
  const channelVideoCountText = `${selectedItemCount} ${selectedItemCount === 1 ? 'video' : 'videos'}`
  return {
    catalogView,
    channelProfile,
    selectedGroupId,
    selectedTab,
    selectedPage,
    isOwner: input.identityDriveKey === input.channelKey,
    activeAvatarUrl,
    bannerUrl,
    channelDisplayName,
    channelDescription,
    channelVideoCountText,
  }
}

function applyResolvedArtwork(
  cacheKey: string,
  resolution: ArtworkResolution,
  setCache: (
    updater: (previous: Record<string, ArtworkResolution>) => Record<string, ArtworkResolution>,
  ) => void,
  cacheRef: { current: Record<string, ArtworkResolution> },
) {
  setCache((previous) => {
    const next = { ...previous, [cacheKey]: resolution }
    cacheRef.current = next
    return next
  })
}

function resolveChannelCardArtwork(input: {
  card: CatalogCard
  channelKey: string
  rpc: ThumbnailRPC | null | undefined
  blobServerPort: number | null | undefined
  startIndex?: number
  initialProvisional?: boolean
  failedUrls?: string[]
  requestGeneration: number
  attempt: number
  cacheKey: string
  isCurrent: () => boolean
  setCache: (
    updater: (previous: Record<string, ArtworkResolution>) => Record<string, ArtworkResolution>,
  ) => void
  cacheRef: { current: Record<string, ArtworkResolution> }
}) {
  return resolveArtworkCandidates(
    input.card.artworkCandidates,
    (candidate: Extract<ArtworkCandidate, { kind: 'blob' }>) => {
      if (!input.rpc) return null
      return fetchThumbnailUrlWithRetry({
        rpc: input.rpc,
        channelKey: input.channelKey,
        videoId: input.card.id,
        expectedPort: input.blobServerPort,
        blobRefs: {
          thumbnailBlobId: candidate.blobId,
          thumbnailBlobsCoreKey: candidate.blobsCoreKey,
          thumbnailMimeType: candidate.mimeType,
        },
      })
    },
    {
      deadline: Date.now() + CHANNEL_ARTWORK_RESOLUTION_MS,
      startIndex: input.startIndex,
      initialProvisional: input.initialProvisional,
      blobResolverAvailable: Boolean(input.rpc),
      failedUrls: input.failedUrls,
    },
  ).then((resolution) => {
    if (!resolution || !input.isCurrent()) return
    applyResolvedArtwork(input.cacheKey, resolution, input.setCache, input.cacheRef)
  })
}

function resolveChannelProfileArtwork(input: {
  placement: 'avatar' | 'banner'
  candidates: ArtworkCandidate[] | undefined
  channelKey: string
  rpc: ThumbnailRPC | null | undefined
  blobServerPort: number | null | undefined
  startIndex?: number
  initialProvisional?: boolean
  failedUrls?: string[]
  isCurrent: () => boolean
  setCache: (
    updater: (previous: Record<string, ArtworkResolution>) => Record<string, ArtworkResolution>,
  ) => void
  cacheRef: { current: Record<string, ArtworkResolution> }
}) {
  if (!input.candidates) return Promise.resolve()
  return resolveArtworkCandidates(
    input.candidates,
    (candidate: Extract<ArtworkCandidate, { kind: 'blob' }>) => {
      if (!input.rpc) return null
      return fetchThumbnailUrlWithRetry({
        rpc: input.rpc,
        channelKey: input.channelKey,
        videoId: `profile:${input.placement}`,
        expectedPort: input.blobServerPort,
        blobRefs: {
          thumbnailBlobId: candidate.blobId,
          thumbnailBlobsCoreKey: candidate.blobsCoreKey,
          thumbnailMimeType: candidate.mimeType,
        },
      })
    },
    {
      deadline: Date.now() + CHANNEL_ARTWORK_RESOLUTION_MS,
      startIndex: input.startIndex,
      initialProvisional: input.initialProvisional,
      blobResolverAvailable: Boolean(input.rpc),
      failedUrls: input.failedUrls,
    },
  ).then((resolution) => {
    if (!resolution || !input.isCurrent()) return
    applyResolvedArtwork(input.placement, resolution, input.setCache, input.cacheRef)
  })
}

async function toggleChannelSubscription(input: {
  channelKey: string
  subscribeBusy: boolean
  isSubscribed: boolean
  setSubscribeBusy: (value: boolean) => void
  setIsSubscribed: (value: boolean) => void
}) {
  if (!input.channelKey || input.subscribeBusy) return
  input.setSubscribeBusy(true)
  const next = !input.isSubscribed
  input.setIsSubscribed(next)
  try {
    if (next) {
      await (rpc as any).subscribeChannel({ channelKey: input.channelKey })
      haptics.success()
    } else {
      await (rpc as any).unsubscribeChannel({ channelKey: input.channelKey })
    }
  } catch {
    input.setIsSubscribed(!next)
  } finally {
    input.setSubscribeBusy(false)
  }
}

async function toggleChannelPin(input: {
  channelKey: string
  isPinned: boolean
  setIsPinned: (value: boolean) => void
}) {
  if (!input.channelKey) return
  const next = !input.isPinned
  input.setIsPinned(next)
  try {
    if (next) {
      await (rpc as any).pinChannel?.({ channelKey: input.channelKey })
      haptics.success()
    } else {
      await (rpc as any).unpinChannel?.({ channelKey: input.channelKey })
    }
  } catch {
    input.setIsPinned(!next)
  }
}

async function pickNativeChannelAvatar(input: {
  setSaveError: (value: string) => void
  setAvatarBase64: (value: string) => void
  setAvatarPreviewUrl: (value: string) => void
}) {
  input.setSaveError('')
  const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (permissionResult.status !== 'granted') {
    input.setSaveError('Photo library permission is required to choose an avatar.')
    return
  }

  const pickerResult = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    base64: true,
  })
  if (pickerResult.canceled || !pickerResult.assets?.[0]) return

  const selectedAsset = pickerResult.assets[0]
  if (!selectedAsset.base64) {
    input.setSaveError('Unable to read selected image.')
    return
  }
  input.setAvatarBase64(selectedAsset.base64)
  input.setAvatarPreviewUrl(selectedAsset.uri)
}

async function saveNativeChannelChanges(input: {
  isSaving: boolean
  avatarBase64: string
  editName: string
  editDescription: string
  setIsSaving: (value: boolean) => void
  setSaveError: (value: string) => void
  setAvatarPreviewUrl: (value: string) => void
  setIsEditModalVisible: (value: boolean) => void
  setAvatarBase64: (value: string) => void
  loadCatalog: () => Promise<unknown> | unknown
}) {
  if (input.isSaving) return
  input.setIsSaving(true)
  input.setSaveError('')
  try {
    if (input.avatarBase64) {
      const avatarUpdateResponse = await (rpc as any).updateChannelAvatar({
        imageData: input.avatarBase64,
        mimeType: 'image/jpeg',
      })
      if (avatarUpdateResponse?.avatarUrl) input.setAvatarPreviewUrl(avatarUpdateResponse.avatarUrl)
    }
    await (rpc as any).updateChannel({
      name: input.editName.trim(),
      description: input.editDescription.trim(),
    })
    await input.loadCatalog()
    input.setIsEditModalVisible(false)
    input.setAvatarBase64('')
  } catch (channelSaveError: any) {
    input.setSaveError(channelSaveError?.message || 'Failed to save channel changes.')
  } finally {
    input.setIsSaving(false)
  }
}

function queueSelectedCardArtwork(input: {
  channelKey: string
  cards: CatalogCard[]
  rpc: unknown
  cacheRef: { current: Record<string, ArtworkResolution> }
  resolveCardArtwork: (
    card: CatalogCard,
    startIndex?: number,
    initialProvisional?: boolean,
    failedUrls?: string[],
  ) => void
}) {
  if (!input.channelKey || input.cards.length === 0) return
  for (const card of input.cards) {
    const current = input.cacheRef.current[`${input.channelKey}:${card.id}`]
    if (current && !(current.provisional && input.rpc)) continue
    void input.resolveCardArtwork(card, 0, false, current?.failedUrls || [])
  }
}

function queueProfileArtwork(input: {
  channelKey: string
  catalogView: CatalogView | null
  rpc: unknown
  cacheRef: { current: Record<string, ArtworkResolution> }
  resolveProfileArtwork: (
    placement: 'avatar' | 'banner',
    startIndex?: number,
    initialProvisional?: boolean,
    failedUrls?: string[],
  ) => void
}) {
  if (!input.channelKey || !input.catalogView) return
  for (const placement of ['avatar', 'banner'] as const) {
    const current = input.cacheRef.current[placement]
    if (current && !(current.provisional && input.rpc)) continue
    void input.resolveProfileArtwork(placement, 0, false, current?.failedUrls || [])
  }
}




const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

function PressableFeedback({
  children,
  className,
  enableMotion = true,
  ...props
}: PressableProps & { enableMotion?: boolean }) {
  const scale = useSharedValue(1)
  const opacity = useSharedValue(1)

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.9, { damping: 15, stiffness: 400 })
    opacity.value = withSpring(0.7, { damping: 15, stiffness: 400 })
  }, [opacity, scale])

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 })
    opacity.value = withSpring(1, { damping: 15, stiffness: 400 })
  }, [opacity, scale])

  const animatedStyle = useAnimatedStyle(() => {
    if (!enableMotion) return {}
    return {
      transform: [{ scale: scale.value }],
      opacity: opacity.value,
    }
  })

  return (
    <AnimatedPressable
      {...props}
      className={className}
      onPressIn={enableMotion ? handlePressIn : undefined}
      onPressOut={enableMotion ? handlePressOut : undefined}
      style={animatedStyle}
    >
      {children}
    </AnimatedPressable>
  )
}

function formatVideoTime(timestamp?: number) {
  if (!timestamp) return 'recently'
  const elapsedSeconds = Math.floor((Date.now() - timestamp) / 1000)
  if (elapsedSeconds < 60) return 'just now'
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours}h ago`
  const elapsedDays = Math.floor(elapsedHours / 24)
  return `${elapsedDays}d ago`
}

function ChannelVideoCard({
  video,
  channelName,
  onPress,
  onThumbnailError,
}: {
  video: ChannelVideo
  channelName: string
  onPress: () => void
  onThumbnailError?: () => void
}) {
  return (
    <PressableFeedback className="mb-4" onPress={onPress} accessibilityRole="button" enableMotion={false}>
      <ThumbnailImage
        thumbnailUrl={video.thumbnailUrl}
        duration={video.duration}
        channelInitial={channelName.charAt(0).toUpperCase() || 'P'}
        onError={onThumbnailError}
      />
      <View className="flex-row mt-3 px-3">
        <View className="w-10 h-10 rounded-full bg-pear-primary items-center justify-center mr-3">
          <Text className="text-label font-semibold" style={{ color: colors.onPrimary }}>{channelName.charAt(0).toUpperCase() || 'P'}</Text>
        </View>
        <View className="flex-1">
          <Text className="text-label text-pear-text" numberOfLines={2}>{video.title || 'Untitled video'}</Text>
          <Text className="text-caption text-pear-text-secondary mt-1" numberOfLines={1}>
            {(() => {
              const badge = formatContentBadge(video)
              return badge ? `${badge} · ` : ''
            })()}{channelName} · {formatVideoTime(video.sourcePublishedAt || video.originalAirDate)}
          </Text>
        </View>
      </View>
    </PressableFeedback>
  )
}

function ChannelPageSkeleton() {
  return (
    <View className="px-5 pt-4 pb-10">
      <View className="flex-row items-center mb-5">
        <Skeleton className="w-20 h-20 rounded-full bg-pear-bg-card" />
        <View className="flex-1 ml-4">
          <Skeleton className="h-6 w-3/5 rounded-md bg-pear-bg-card mb-2" />
          <Skeleton className="h-4 w-full rounded-md bg-pear-bg-card mb-2" />
          <Skeleton className="h-4 w-4/5 rounded-md bg-pear-bg-card" />
        </View>
      </View>
      <Skeleton className="h-56 w-full rounded-xl bg-pear-bg-card mb-4" />
      <Skeleton className="h-56 w-full rounded-xl bg-pear-bg-card mb-4" />
      <Skeleton className="h-56 w-full rounded-xl bg-pear-bg-card" />
    </View>
  )
}

async function fetchChannelSocialState(rpcClient: unknown, channelKey: string) {
  let isSubscribed = false
  let isPinned = false
  try {
    const rpcObj = rpcClient as {
      getSubscriptions?: (arg: unknown) => Promise<{ subscriptions?: Array<{ channelKey?: string }> }>
      getPinnedChannels?: () => Promise<{ channels?: string[] }>
    }
    const subs = await rpcObj.getSubscriptions?.({})
    if (Array.isArray(subs?.subscriptions)) {
      isSubscribed = subs.subscriptions.some((sub) => sub.channelKey === channelKey)
    }
    const pinned = await rpcObj.getPinnedChannels?.()
    if (Array.isArray(pinned?.channels)) {
      isPinned = pinned.channels.includes(channelKey)
    }
  } catch { /* subscription/pin state is best-effort */ }
  return { isSubscribed, isPinned }
}

function ChannelErrorView({
  error,
  onRetry,
}: {
  error: string
  onRetry: () => void
}) {
  return (
    <View className="flex-1 px-8 items-center justify-center">
      <Feather name="alert-circle" size={36} color={colors.error} />
      <Text className="text-body text-pear-text mt-4 text-center" selectable>{error}</Text>
      <PressableFeedback onPress={onRetry} className="mt-5 bg-pear-primary rounded-lg px-5 py-3" accessibilityRole="button">
        <Text className="text-label" style={{ color: colors.onPrimary }}>Retry</Text>
      </PressableFeedback>
    </View>
  )
}

function ChannelHeroAvatar({
  activeAvatarUrl,
  avatarPreviewUrl,
  channelDisplayName,
  onAvatarError,
}: {
  activeAvatarUrl: string
  avatarPreviewUrl: string
  channelDisplayName: string
  onAvatarError: () => void
}) {
  if (activeAvatarUrl) {
    return (
      <Image
        source={{ uri: activeAvatarUrl }}
        style={styles.avatarImage}
        resizeMode="cover"
        onError={avatarPreviewUrl ? undefined : onAvatarError}
      />
    )
  }
  return <Text style={styles.avatarInitial}>{channelDisplayName.charAt(0).toUpperCase() || 'P'}</Text>
}

function ChannelHeroActions({
  isOwner,
  isSubscribed,
  subscribeBusy,
  isPinned,
  onEditPress,
  onToggleSubscribe,
  onTogglePin,
}: {
  isOwner: boolean
  isSubscribed: boolean
  subscribeBusy: boolean
  isPinned: boolean
  onEditPress: () => void
  onToggleSubscribe: () => void
  onTogglePin: () => void
}) {
  if (isOwner) {
    return (
      <PressableFeedback onPress={onEditPress} className="mt-5 rounded-full px-4 py-3 flex-row items-center justify-center gap-2" accessibilityRole="button">
        <Feather name="edit-2" size={16} color={colors.text} />
        <Text style={styles.editButtonText}>Edit Channel</Text>
      </PressableFeedback>
    )
  }
  return (
    <View style={styles.heroActions}>
      <Pressable
        onPress={onToggleSubscribe}
        disabled={subscribeBusy}
        accessibilityRole="button"
        accessibilityLabel={isSubscribed ? 'Unsubscribe' : 'Subscribe'}
        style={({ pressed }) => [
          styles.subscribeButton,
          isSubscribed && styles.subscribeButtonActive,
          (pressed || subscribeBusy) && { opacity: 0.75 },
        ]}
      >
        <Feather name={isSubscribed ? 'check' : 'user-plus'} size={15} color={isSubscribed ? colors.textSecondary : colors.onPrimary} />
        <Text style={[styles.subscribeLabel, isSubscribed && styles.subscribeLabelActive]}>
          {isSubscribed ? 'Subscribed' : 'Subscribe'}
        </Text>
      </Pressable>
      <Pressable
        onPress={onTogglePin}
        accessibilityRole="button"
        accessibilityLabel={isPinned ? 'Stop keeping this channel online' : 'Keep this channel online'}
        style={({ pressed }) => [styles.pinButton, isPinned && styles.pinButtonActive, pressed && { opacity: 0.75 }]}
      >
        <Feather name="anchor" size={15} color={isPinned ? colors.onPrimary : colors.textSecondary} />
      </Pressable>
    </View>
  )
}

function ChannelHeroTabs({
  tabs,
  selectedGroupId,
  onSelectGroup,
}: {
  tabs: Array<{ id: string; label: string; itemCount: number }>
  selectedGroupId: string
  onSelectGroup: (id: string) => void
}) {
  if (!tabs.length) return null
  return (
    <View style={styles.tabRow}>
      {tabs.map((tab) => {
        const active = tab.id === selectedGroupId
        return (
          <Pressable
            key={tab.id}
            onPress={() => onSelectGroup(tab.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[styles.tabButton, active && styles.tabButtonActive]}
          >
            <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{tab.label}</Text>
            <Text style={[styles.tabCount, active && styles.tabLabelActive]}>{tab.itemCount}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function ChannelHeaderView({
  bannerUrl,
  activeAvatarUrl,
  avatarPreviewUrl,
  channelDisplayName,
  catalogView,
  channelDescription,
  channelVideoCountText,
  channelKey,
  isOwner,
  isSubscribed,
  subscribeBusy,
  isPinned,
  selectedTab,
  selectedGroupId,
  selectedPageError,
  onEditPress,
  onToggleSubscribe,
  onTogglePin,
  onSelectGroup,
  onRetryGroup,
  onBannerError,
  onAvatarError,
}: {
  bannerUrl: string
  activeAvatarUrl: string
  avatarPreviewUrl: string
  channelDisplayName: string
  catalogView: any
  channelDescription: string
  channelVideoCountText: string
  channelKey: string
  isOwner: boolean
  isSubscribed: boolean
  subscribeBusy: boolean
  isPinned: boolean
  selectedTab: any
  selectedGroupId: string
  selectedPageError?: string
  onEditPress: () => void
  onToggleSubscribe: () => void
  onTogglePin: () => void
  onSelectGroup: (id: string) => void
  onRetryGroup: () => void
  onBannerError: () => void
  onAvatarError: () => void
}) {
  return (
    <>
      {bannerUrl ? (
        <Image
          source={{ uri: bannerUrl }}
          style={styles.bannerImage}
          resizeMode="cover"
          onError={onBannerError}
        />
      ) : null}
      <View style={styles.hero}>
        <View style={styles.avatarShell}>
          <ChannelHeroAvatar
            activeAvatarUrl={activeAvatarUrl}
            avatarPreviewUrl={avatarPreviewUrl}
            channelDisplayName={channelDisplayName}
            onAvatarError={onAvatarError}
          />
        </View>

        <View style={styles.heroCopy}>
          <View style={styles.profileTitleRow}>
            <Text style={styles.channelTitle} numberOfLines={2} selectable>{channelDisplayName}</Text>
            {catalogView?.badge ? <Text style={styles.profileBadge}>{catalogView.badge}</Text> : null}
          </View>
          <Text style={styles.channelDescription} numberOfLines={3} selectable>{channelDescription}</Text>
          <View style={styles.heroMetaRow}>
            <View style={styles.videoCountPill}>
              <Feather name="film" size={13} color={colors.textSecondary} />
              <Text style={styles.videoCountText}>{channelVideoCountText}</Text>
            </View>
            <Text style={styles.channelKeyText}>{channelKey.slice(0, 12)}...</Text>
          </View>
        </View>

        <ChannelHeroActions
          isOwner={isOwner}
          isSubscribed={isSubscribed}
          subscribeBusy={subscribeBusy}
          isPinned={isPinned}
          onEditPress={onEditPress}
          onToggleSubscribe={onToggleSubscribe}
          onTogglePin={onTogglePin}
        />
      </View>

      <ChannelHeroTabs
        tabs={catalogView?.tabs || []}
        selectedGroupId={selectedGroupId}
        onSelectGroup={onSelectGroup}
      />

      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>{selectedTab?.sectionLabel || 'Latest'}</Text>
      </View>
      {selectedPageError ? (
        <View style={styles.inlineError}>
          <Text className="text-body text-pear-text-secondary" selectable>{selectedPageError}</Text>
          <PressableFeedback onPress={onRetryGroup} className="mt-3 self-start bg-pear-primary rounded-lg px-4 py-2" accessibilityRole="button">
            <Text className="text-label" style={{ color: colors.onPrimary }}>Retry</Text>
          </PressableFeedback>
        </View>
      ) : null}
    </>
  )
}

function EditChannelModal({
  visible,
  isSaving,
  editName,
  editDescription,
  saveError,
  onNameChange,
  onDescriptionChange,
  onPickAvatar,
  onClose,
  onSave,
}: {
  visible: boolean
  isSaving: boolean
  editName: string
  editDescription: string
  saveError: string
  onNameChange: (text: string) => void
  onDescriptionChange: (text: string) => void
  onPickAvatar: () => void
  onClose: () => void
  onSave: () => void
}) {
  const nativeFormButtonStyle = { flex: 1 }
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View className="flex-1 bg-black/70 justify-end">
        <View className="bg-pear-bg-card rounded-t-3xl max-h-[90%] border-t border-pear-border">
          <View className="px-5 py-4 border-b border-pear-border flex-row items-center justify-between">
            <Text className="text-headline text-pear-text">Edit Channel</Text>
            <PressableFeedback onPress={onClose} className="w-9 h-9 rounded-full bg-pear-bg-input items-center justify-center" accessibilityRole="button">
              <Feather name="x" size={18} color={colors.text} />
            </PressableFeedback>
          </View>

          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 20 }}
          >
            <Text className="text-label text-pear-text mb-1.5">Channel Name</Text>
            <NativeTextInput
              value={editName}
              onChangeText={onNameChange}
              placeholderTextColor={colors.textMuted}
              className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3.5 text-body text-pear-text"
            />

            <View className="mt-4">
              <Text className="text-label text-pear-text mb-1.5">Description</Text>
              <NativeTextInput
                value={editDescription}
                onChangeText={onDescriptionChange}
                placeholderTextColor={colors.textMuted}
                multiline
                textAlignVertical="top"
                className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3.5 text-body text-pear-text min-h-28"
              />
            </View>

            <View className="mt-4">
              <NativeButton label="Choose Avatar" onPress={onPickAvatar} variant="outlined" style={nativeFormButtonStyle} />
            </View>

            {saveError ? <Text className="text-pear-error text-caption mt-3">{saveError}</Text> : null}
          </ScrollView>

          <View className="px-5 py-4 border-t border-pear-border flex-row gap-3">
            <NativeButton label="Cancel" onPress={onClose} disabled={isSaving} variant="outlined" style={nativeFormButtonStyle} />
            <NativeButton label={isSaving ? 'Saving...' : 'Save'} onPress={onSave} disabled={isSaving} variant="filled" style={nativeFormButtonStyle} />
          </View>
        </View>
      </View>
    </Modal>
  )
}

function retryArtworkResolution(
  artwork: ArtworkResolution | undefined,
  resolve: (startIndex: number, provisional: boolean, failedUrls: string[]) => void,
) {
  if (!artwork?.url) return
  resolve(artwork.nextIndex, artwork.provisional, [...artwork.failedUrls, artwork.url])
}

function ChannelCatalogEmpty({
  loading,
  error,
  tabLabel,
}: {
  loading: boolean
  error: string | null | undefined
  tabLabel?: string | null
}) {
  if (loading) {
    return (
      <View style={styles.emptyState}>
        <ActivityIndicator color={colors.primary} />
        <Text className="text-body text-pear-text-secondary mt-3">Loading {tabLabel || 'videos'}...</Text>
      </View>
    )
  }
  if (error) return null
  return (
    <View style={styles.emptyState}>
      <Feather name="video-off" size={30} color={colors.textMuted} />
      <Text className="text-body text-pear-text-secondary mt-3">No videos yet</Text>
    </View>
  )
}

function ChannelLoadMoreFooter({
  nextCursor,
  loadingMore,
  onLoadMore,
}: {
  nextCursor?: string | null
  loadingMore: boolean
  onLoadMore: () => void
}) {
  if (!nextCursor) return null
  return (
    <Pressable
      onPress={onLoadMore}
      disabled={loadingMore}
      accessibilityRole="button"
      style={({ pressed }) => [styles.loadMoreButton, (pressed || loadingMore) && { opacity: 0.75 }]}
    >
      {loadingMore ? <ActivityIndicator size="small" color={colors.onPrimary} /> : null}
      <Text style={styles.loadMoreLabel}>{loadingMore ? 'Loading...' : 'Load more'}</Text>
    </Pressable>
  )
}

function ChannelCatalogList({
  catalogState,
  catalogView,
  groupedCards,
  selectedPage,
  selectedTab,
  selectedGroupId,
  bannerUrl,
  activeAvatarUrl,
  avatarPreviewUrl,
  channelDisplayName,
  channelDescription,
  channelVideoCountText,
  channelKey,
  isOwner,
  isSubscribed,
  subscribeBusy,
  isPinned,
  profileArtworkCache,
  onLoadCatalog,
  onEditPress,
  onToggleSubscribe,
  onTogglePin,
  onSelectGroup,
  onRetryGroup,
  onResolveProfileArtwork,
  onLoadMore,
  renderCatalogCard,
}: {
  catalogState: CatalogStateSnapshot
  catalogView: CatalogView | null
  groupedCards: CatalogCard[]
  selectedPage: GroupPageState
  selectedTab: CatalogTab | null
  selectedGroupId: string
  bannerUrl: string
  activeAvatarUrl: string
  avatarPreviewUrl: string
  channelDisplayName: string
  channelDescription: string
  channelVideoCountText: string
  channelKey: string
  isOwner: boolean
  isSubscribed: boolean
  subscribeBusy: boolean
  isPinned: boolean
  profileArtworkCache: Record<string, ArtworkResolution>
  onLoadCatalog: () => void
  onEditPress: () => void
  onToggleSubscribe: () => void
  onTogglePin: () => void
  onSelectGroup: (groupId: string) => void
  onRetryGroup: () => void
  onResolveProfileArtwork: (
    placement: 'avatar' | 'banner',
    startIndex?: number,
    initialProvisional?: boolean,
    failedUrls?: string[],
  ) => void
  onLoadMore: () => void
  renderCatalogCard: ({ item }: { item: CatalogCard }) => ReactElement
}) {
  if (catalogState.catalogLoading) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false}>
        <ChannelPageSkeleton />
      </ScrollView>
    )
  }
  if (catalogState.catalogError && !catalogView) {
    return <ChannelErrorView error={catalogState.catalogError} onRetry={onLoadCatalog} />
  }
  return (
    <FlatList
      data={groupedCards}
      keyExtractor={(card) => card.id}
      renderItem={renderCatalogCard}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.scrollContent}
      ListHeaderComponent={(
        <ChannelHeaderView
          bannerUrl={bannerUrl}
          activeAvatarUrl={activeAvatarUrl}
          avatarPreviewUrl={avatarPreviewUrl}
          channelDisplayName={channelDisplayName}
          catalogView={catalogView}
          channelDescription={channelDescription}
          channelVideoCountText={channelVideoCountText}
          channelKey={channelKey}
          isOwner={isOwner}
          isSubscribed={isSubscribed}
          subscribeBusy={subscribeBusy}
          isPinned={isPinned}
          selectedTab={selectedTab}
          selectedGroupId={selectedGroupId}
          selectedPageError={selectedPage.error}
          onEditPress={onEditPress}
          onToggleSubscribe={onToggleSubscribe}
          onTogglePin={onTogglePin}
          onSelectGroup={onSelectGroup}
          onRetryGroup={onRetryGroup}
          onBannerError={() => {
            retryArtworkResolution(profileArtworkCache.banner, (startIndex, provisional, failedUrls) => {
              void onResolveProfileArtwork('banner', startIndex, provisional, failedUrls)
            })
          }}
          onAvatarError={() => {
            retryArtworkResolution(profileArtworkCache.avatar, (startIndex, provisional, failedUrls) => {
              void onResolveProfileArtwork('avatar', startIndex, provisional, failedUrls)
            })
          }}
        />
      )}
      ListEmptyComponent={(
        <ChannelCatalogEmpty
          loading={selectedPage.loading}
          error={selectedPage.error}
          tabLabel={selectedTab?.label}
        />
      )}
      ListFooterComponent={(
        <ChannelLoadMoreFooter
          nextCursor={selectedPage.nextCursor}
          loadingMore={selectedPage.loadingMore}
          onLoadMore={onLoadMore}
        />
      )}
    />
  )
}

export default function ChannelScreen() {
  const router = useRouter()
  const { key, publicBeeKey } = useLocalSearchParams<{ key: string | string[], publicBeeKey?: string | string[] }>()
  const channelKey = useMemo(() => resolveRouteParam(key), [key])
  const channelPublicBeeKey = useMemo(() => resolveRouteParam(publicBeeKey), [publicBeeKey])

  const { rpc: appRpc, blobServerPort } = useApp()
  const [catalogState, setCatalogState] = useState<CatalogStateSnapshot>(INITIAL_CATALOG_STATE)
  const catalogController = useMemo(() => createChannelCatalogState({
    rpc,
    bound: withChannelPageTimeout,
    onChange: (nextState: CatalogStateSnapshot) => setCatalogState(nextState),
  }), [])
  const [thumbnailCache, setThumbnailCache] = useState<Record<string, ArtworkResolution>>({})
  const thumbnailCacheRef = useRef<Record<string, ArtworkResolution>>({})
  const [profileArtworkCache, setProfileArtworkCache] = useState<Record<string, ArtworkResolution>>({})
  const profileArtworkCacheRef = useRef<Record<string, ArtworkResolution>>({})
  const [identityDriveKey, setIdentityDriveKey] = useState('')

  const thumbnailRequestGeneration = useRef(0)
  const profileArtworkRequestGeneration = useRef(0)
  const thumbnailAttempt = useRef<Record<string, number>>({})
  const profileArtworkAttempt = useRef<Record<string, number>>({})

  const [isSubscribed, setIsSubscribed] = useState(false)
  const [subscribeBusy, setSubscribeBusy] = useState(false)
  const [isPinned, setIsPinned] = useState(false)

  const [isEditModalVisible, setIsEditModalVisible] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState('')
  const [avatarBase64, setAvatarBase64] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const {
    catalogView,
    channelProfile,
    selectedGroupId,
    selectedTab,
    selectedPage,
    isOwner,
    activeAvatarUrl,
    bannerUrl,
    channelDisplayName,
    channelDescription,
    channelVideoCountText,
  } = buildChannelScreenPresentation({
    catalogState,
    channelKey,
    identityDriveKey,
    profileArtworkCache,
    avatarPreviewUrl,
  })
  const groupedCards = useMemo(() => groupCardsBySeason(selectedPage.cards), [selectedPage.cards])

  const loadCatalog = useCallback(() => {
    thumbnailCacheRef.current = {}
    setThumbnailCache({})
    setProfileArtworkCache({})
    profileArtworkCacheRef.current = {}
    thumbnailAttempt.current = {}
    profileArtworkAttempt.current = {}
    setAvatarPreviewUrl('')
    thumbnailRequestGeneration.current += 1
    profileArtworkRequestGeneration.current += 1
    return catalogController.loadCatalog({
      channelKey,
      publicBeeKey: channelPublicBeeKey,
    })
  }, [catalogController, channelKey, channelPublicBeeKey])

  useEffect(() => {
    void loadCatalog()
    return () => {
      catalogController.dispose()
      thumbnailRequestGeneration.current += 1
      profileArtworkRequestGeneration.current += 1
    }
  }, [catalogController, loadCatalog])
  const resolveCardArtwork = useCallback((
    card: CatalogCard,
    startIndex = 0,
    initialProvisional = false,
    failedUrls: string[] = [],
  ) => {
    const cacheKey = `${channelKey}:${card.id}`
    const requestGeneration = thumbnailRequestGeneration.current
    const attempt = (thumbnailAttempt.current[cacheKey] || 0) + 1
    thumbnailAttempt.current[cacheKey] = attempt
    return resolveChannelCardArtwork({
      card,
      channelKey,
      rpc: appRpc,
      blobServerPort,
      startIndex,
      initialProvisional,
      failedUrls,
      requestGeneration,
      attempt,
      cacheKey,
      isCurrent: () => (
        requestGeneration === thumbnailRequestGeneration.current &&
        thumbnailAttempt.current[cacheKey] === attempt
      ),
      setCache: setThumbnailCache,
      cacheRef: thumbnailCacheRef,
    })
  }, [appRpc, blobServerPort, channelKey])

  useEffect(() => {
    const requestGeneration = ++thumbnailRequestGeneration.current
    queueSelectedCardArtwork({
      channelKey,
      cards: selectedPage.cards,
      rpc: appRpc,
      cacheRef: thumbnailCacheRef,
      resolveCardArtwork,
    })
    return () => {
      if (thumbnailRequestGeneration.current === requestGeneration) {
        thumbnailRequestGeneration.current += 1
      }
    }
  }, [appRpc, channelKey, resolveCardArtwork, selectedPage.cards])

  const resolveProfileArtwork = useCallback((
    placement: 'avatar' | 'banner',
    startIndex = 0,
    initialProvisional = false,
    failedUrls: string[] = [],
  ) => {
    const requestGeneration = profileArtworkRequestGeneration.current
    const attempt = (profileArtworkAttempt.current[placement] || 0) + 1
    profileArtworkAttempt.current[placement] = attempt
    return resolveChannelProfileArtwork({
      placement,
      candidates: catalogView?.profileArtwork[placement],
      channelKey,
      rpc: appRpc,
      blobServerPort,
      startIndex,
      initialProvisional,
      failedUrls,
      isCurrent: () => (
        requestGeneration === profileArtworkRequestGeneration.current &&
        profileArtworkAttempt.current[placement] === attempt
      ),
      setCache: setProfileArtworkCache,
      cacheRef: profileArtworkCacheRef,
    })
  }, [appRpc, blobServerPort, catalogView, channelKey])

  useEffect(() => {
    const requestGeneration = ++profileArtworkRequestGeneration.current
    queueProfileArtwork({
      channelKey,
      catalogView,
      rpc: appRpc,
      cacheRef: profileArtworkCacheRef,
      resolveProfileArtwork,
    })
    return () => {
      if (profileArtworkRequestGeneration.current === requestGeneration) {
        profileArtworkRequestGeneration.current += 1
      }
    }
  }, [appRpc, catalogView, channelKey, resolveProfileArtwork])

  useEffect(() => {
    let isMounted = true
    const loadIdentity = async () => {
      try {
        const currentIdentity = await rpc.getIdentity()
        if (isMounted) setIdentityDriveKey(currentIdentity?.driveKey || '')
      } catch {
        if (isMounted) setIdentityDriveKey('')
      }
    }
    void loadIdentity()
    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    if (!channelKey) return
    let isMounted = true
    void fetchChannelSocialState(rpc, channelKey).then((state) => {
      if (!isMounted) return
      setIsSubscribed(state.isSubscribed)
      setIsPinned(state.isPinned)
    })
    return () => {
      isMounted = false
    }
  }, [channelKey])

  const selectGroup = useCallback((groupId: string) => {
    thumbnailRequestGeneration.current += 1
    void catalogController.selectGroup(groupId)
  }, [catalogController])

  const retrySelectedGroup = useCallback(() => {
    void catalogController.retrySelectedGroup()
  }, [catalogController])

  const loadMore = useCallback(() => {
    void catalogController.loadMore()
  }, [catalogController])

  const toggleSubscribe = useCallback(async () => {
    await toggleChannelSubscription({
      channelKey,
      subscribeBusy,
      isSubscribed,
      setSubscribeBusy,
      setIsSubscribed,
    })
  }, [channelKey, isSubscribed, subscribeBusy])

  const togglePin = useCallback(async () => {
    await toggleChannelPin({
      channelKey,
      isPinned,
      setIsPinned,
    })
  }, [channelKey, isPinned])

  const openEditModal = useCallback(() => {
    setSaveError('')
    setAvatarBase64('')
    setAvatarPreviewUrl(activeAvatarUrl)
    setEditName(channelProfile?.name || '')
    setEditDescription(channelProfile?.description || '')
    setIsEditModalVisible(true)
  }, [activeAvatarUrl, channelProfile])

  const closeEditModal = useCallback(() => {
    if (isSaving) return
    setIsEditModalVisible(false)
    setSaveError('')
  }, [isSaving])

  const pickAvatar = useCallback(async () => {
    await pickNativeChannelAvatar({
      setSaveError,
      setAvatarBase64,
      setAvatarPreviewUrl,
    })
  }, [])

  const saveChannelChanges = useCallback(async () => {
    await saveNativeChannelChanges({
      isSaving,
      avatarBase64,
      editName,
      editDescription,
      setIsSaving,
      setSaveError,
      setAvatarPreviewUrl,
      setIsEditModalVisible,
      setAvatarBase64,
      loadCatalog,
    })
  }, [avatarBase64, editDescription, editName, isSaving, loadCatalog])

  const renderCatalogCard = useCallback(({ item: card }: { item: CatalogCard }) => {
    const channelVideo = card.item
    const artwork = thumbnailCache[`${channelKey}:${card.id}`]
    const thumbnailUrl = artwork?.url || null
    const failedThumbnailUrl = artwork?.url || ''
    const playbackPayload = createChannelPlaybackPayload({
      item: channelVideo,
      channelKey,
      publicBeeKey: channelPublicBeeKey,
      thumbnailUrl,
      channelName: channelDisplayName,
    })
    return (
      <>
        {card.sectionLabel ? (
          <Text style={styles.seasonHeader}>{card.sectionLabel}</Text>
        ) : null}
        <ChannelVideoCard
          video={{ ...channelVideo, thumbnailUrl }}
          channelName={channelDisplayName}
          onThumbnailError={artwork && failedThumbnailUrl ? () => {
            void resolveCardArtwork(
              card,
              artwork.nextIndex,
              artwork.provisional,
              [...artwork.failedUrls, failedThumbnailUrl],
            )
          } : undefined}
          onPress={() => router.push({
            pathname: '/video/[id]',
            params: {
              id: channelVideo.id,
              channel: channelKey,
              publicBeeKey: playbackPayload.publicBeeKey,
              videoData: JSON.stringify(playbackPayload),
            },
          })}
        />
      </>
    )
  }, [channelDisplayName, channelKey, channelPublicBeeKey, resolveCardArtwork, router, thumbnailCache])

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.topBar}>
        <PressableFeedback
          onPress={() => router.back()}
          className="w-10 h-10 rounded-full items-center justify-center mr-3"
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Feather name="chevron-left" size={20} color={colors.text} />
        </PressableFeedback>
        <Text style={styles.topBarTitle} numberOfLines={1}>Channel</Text>
      </View>

      <ChannelCatalogList
        catalogState={catalogState}
        catalogView={catalogView}
        groupedCards={groupedCards}
        selectedPage={selectedPage}
        selectedTab={selectedTab}
        selectedGroupId={selectedGroupId}
        bannerUrl={bannerUrl}
        activeAvatarUrl={activeAvatarUrl}
        avatarPreviewUrl={avatarPreviewUrl}
        channelDisplayName={channelDisplayName}
        channelDescription={channelDescription}
        channelVideoCountText={channelVideoCountText}
        channelKey={channelKey}
        isOwner={isOwner}
        isSubscribed={isSubscribed}
        subscribeBusy={subscribeBusy}
        isPinned={isPinned}
        profileArtworkCache={profileArtworkCache}
        onLoadCatalog={loadCatalog}
        onEditPress={openEditModal}
        onToggleSubscribe={toggleSubscribe}
        onTogglePin={togglePin}
        onSelectGroup={selectGroup}
        onRetryGroup={retrySelectedGroup}
        onResolveProfileArtwork={resolveProfileArtwork}
        onLoadMore={loadMore}
        renderCatalogCard={renderCatalogCard}
      />

      <EditChannelModal
        visible={isEditModalVisible}
        isSaving={isSaving}
        editName={editName}
        editDescription={editDescription}
        saveError={saveError}
        onNameChange={setEditName}
        onDescriptionChange={setEditDescription}
        onPickAvatar={pickAvatar}
        onClose={closeEditModal}
        onSave={saveChannelChanges}
      />
    </SafeAreaView>
  )
}
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  seasonHeader: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
    marginTop: 10,
    marginBottom: 12,
  },
  topBarTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: -0.25,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 34,
  },
  hero: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 18,
    overflow: 'hidden',
  },
  avatarShell: {
    width: 82,
    height: 82,
    borderRadius: 28,
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  avatarImage: {
    width: '100%',
    height: '100%',
    borderRadius: 27,
  },
  avatarInitial: {
    color: colors.onPrimary,
    fontSize: 30,
    fontFamily: fonts.heading,
  },
  heroCopy: {
    gap: 8,
  },
  channelTitle: {
    color: colors.text,
    fontSize: 28,
    lineHeight: 33,
    fontFamily: fonts.heading,
    letterSpacing: -0.65,
  },
  channelDescription: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  heroMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  videoCountPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  videoCountText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  channelKeyText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  editButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  heroActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 18,
  },
  subscribeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.primary,
  },
  subscribeButtonActive: {
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  subscribeLabel: {
    color: colors.onPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  subscribeLabelActive: {
    color: colors.textSecondary,
  },
  pinButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  pinButtonActive: {
    backgroundColor: colors.swarm,
    borderColor: colors.swarm,
  },
  bannerImage: {
    width: '100%',
    height: 150,
    borderRadius: 20,
    marginBottom: 12,
    backgroundColor: colors.bgElevated,
  },
  profileTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  profileBadge: {
    color: colors.onPrimary,
    backgroundColor: colors.primary,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden',
  },
  tabRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingTop: 18,
  },
  tabButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tabButtonActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  tabLabel: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  tabLabelActive: {
    color: colors.onPrimary,
  },
  tabCount: {
    color: colors.textMuted,
    fontSize: 11,
  },
  sectionHeading: {
    paddingTop: 24,
    paddingBottom: 12,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 20,
    fontFamily: fonts.heading,
  },
  inlineError: {
    marginBottom: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 14,
  },
  emptyState: {
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  loadMoreButton: {
    minHeight: 44,
    marginTop: 4,
    marginBottom: 20,
    borderRadius: 22,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loadMoreLabel: {
    color: colors.onPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
})
