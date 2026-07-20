import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { fetchThumbnailUrlWithRetry } from '@/lib/thumbnail'
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

export default function ChannelScreen() {
  const router = useRouter()
  const { key, publicBeeKey } = useLocalSearchParams<{ key: string | string[], publicBeeKey?: string | string[] }>()
  const channelKey = useMemo(() => (Array.isArray(key) ? key[0] : key) || '', [key])
  const channelPublicBeeKey = useMemo(() => (Array.isArray(publicBeeKey) ? publicBeeKey[0] : publicBeeKey) || '', [publicBeeKey])

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
  const nativeFormButtonStyle = { flex: 1 }

  const catalogView = catalogState.catalog
  const channelProfile = catalogView?.profile || null
  const selectedGroupId = catalogState.selectedGroupId
  const selectedTab = catalogView?.tabs.find((tab) => tab.id === selectedGroupId) || null
  const selectedPage = catalogState.pages[selectedGroupId] || EMPTY_GROUP_PAGE
  const groupedCards = useMemo(() => groupCardsBySeason(selectedPage.cards), [selectedPage.cards])
  const isOwner = identityDriveKey === channelKey
  const mappedAvatarUrl = profileArtworkCache.avatar?.url || ''
  const activeAvatarUrl = avatarPreviewUrl || mappedAvatarUrl
  const bannerUrl = profileArtworkCache.banner?.url || ''
  const channelDisplayName = channelProfile?.name?.trim() || `Channel ${channelKey.slice(0, 8)}`
  const channelDescription = channelProfile?.description?.trim() || 'No channel description yet.'
  const selectedItemCount = selectedTab?.itemCount || selectedPage.cards.length
  const channelVideoCountText = `${selectedItemCount} ${selectedItemCount === 1 ? 'video' : 'videos'}`

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
    return resolveArtworkCandidates(
      card.artworkCandidates,
      (candidate: Extract<ArtworkCandidate, { kind: 'blob' }>) => {
        if (!appRpc) return null
        return fetchThumbnailUrlWithRetry({
          rpc: appRpc,
          channelKey,
          videoId: card.id,
          expectedPort: blobServerPort,
          blobRefs: {
            thumbnailBlobId: candidate.blobId,
            thumbnailBlobsCoreKey: candidate.blobsCoreKey,
            thumbnailMimeType: candidate.mimeType,
          },
        })
      },
      {
        deadline: Date.now() + CHANNEL_ARTWORK_RESOLUTION_MS,
        startIndex,
        initialProvisional,
        blobResolverAvailable: Boolean(appRpc),
        failedUrls,
      },
    ).then((resolution) => {
      if (
        !resolution ||
        requestGeneration !== thumbnailRequestGeneration.current ||
        thumbnailAttempt.current[cacheKey] !== attempt
      ) return
      setThumbnailCache((previous) => {
        const next = { ...previous, [cacheKey]: resolution }
        thumbnailCacheRef.current = next
        return next
      })
    })
  }, [appRpc, blobServerPort, channelKey])

  useEffect(() => {
    if (!channelKey || selectedPage.cards.length === 0) return
    const requestGeneration = ++thumbnailRequestGeneration.current

    for (const card of selectedPage.cards) {
      const current = thumbnailCacheRef.current[`${channelKey}:${card.id}`]
      if (current && !(current.provisional && appRpc)) continue
      void resolveCardArtwork(card, 0, false, current?.failedUrls || [])
    }

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
    const candidates = catalogView?.profileArtwork[placement]
    if (!candidates) return Promise.resolve()
    const requestGeneration = profileArtworkRequestGeneration.current
    const attempt = (profileArtworkAttempt.current[placement] || 0) + 1
    profileArtworkAttempt.current[placement] = attempt
    return resolveArtworkCandidates(
      candidates,
      (candidate: Extract<ArtworkCandidate, { kind: 'blob' }>) => {
        if (!appRpc) return null
        return fetchThumbnailUrlWithRetry({
          rpc: appRpc,
          channelKey,
          videoId: `profile:${placement}`,
          expectedPort: blobServerPort,
          blobRefs: {
            thumbnailBlobId: candidate.blobId,
            thumbnailBlobsCoreKey: candidate.blobsCoreKey,
            thumbnailMimeType: candidate.mimeType,
          },
        })
      },
      {
        deadline: Date.now() + CHANNEL_ARTWORK_RESOLUTION_MS,
        startIndex,
        initialProvisional,
        blobResolverAvailable: Boolean(appRpc),
        failedUrls,
      },
    ).then((resolution) => {
      if (
        !resolution ||
        requestGeneration !== profileArtworkRequestGeneration.current ||
        profileArtworkAttempt.current[placement] !== attempt
      ) return
      setProfileArtworkCache((previous) => {
        const next = { ...previous, [placement]: resolution }
        profileArtworkCacheRef.current = next
        return next
      })
    })
  }, [appRpc, blobServerPort, catalogView, channelKey])

  useEffect(() => {
    if (!channelKey || !catalogView) return
    const requestGeneration = ++profileArtworkRequestGeneration.current

    for (const placement of ['avatar', 'banner'] as const) {
      const current = profileArtworkCacheRef.current[placement]
      if (current && !(current.provisional && appRpc)) continue
      void resolveProfileArtwork(placement, 0, false, current?.failedUrls || [])
    }
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
    ;(async () => {
      try {
        const subs = await (rpc as any).getSubscriptions?.({})
        if (isMounted && Array.isArray(subs?.subscriptions)) {
          setIsSubscribed(subs.subscriptions.some((subscription: any) => subscription.channelKey === channelKey))
        }
      } catch {}
      try {
        const pinned = await (rpc as any).getPinnedChannels?.()
        if (isMounted && Array.isArray(pinned?.channels)) {
          setIsPinned(pinned.channels.includes(channelKey))
        }
      } catch {}
    })()
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
    if (!channelKey || subscribeBusy) return
    setSubscribeBusy(true)
    const next = !isSubscribed
    setIsSubscribed(next)
    try {
      if (next) {
        await (rpc as any).subscribeChannel({ channelKey })
        haptics.success()
      } else {
        await (rpc as any).unsubscribeChannel({ channelKey })
      }
    } catch {
      setIsSubscribed(!next)
    } finally {
      setSubscribeBusy(false)
    }
  }, [channelKey, isSubscribed, subscribeBusy])

  const togglePin = useCallback(async () => {
    if (!channelKey) return
    const next = !isPinned
    setIsPinned(next)
    try {
      if (next) {
        await (rpc as any).pinChannel?.({ channelKey })
        haptics.success()
      } else {
        await (rpc as any).unpinChannel?.({ channelKey })
      }
    } catch {
      setIsPinned(!next)
    }
  }, [channelKey, isPinned])

  const openEditModal = useCallback(() => {
    setSaveError('')
    setAvatarBase64('')
    setAvatarPreviewUrl(activeAvatarUrl)
    setEditName(channelProfile?.name || '')
    setEditDescription(channelProfile?.description || '')
    setIsEditModalVisible(true)
  }, [activeAvatarUrl, channelProfile?.description, channelProfile?.name])

  const closeEditModal = useCallback(() => {
    if (isSaving) return
    setIsEditModalVisible(false)
    setSaveError('')
  }, [isSaving])

  const pickAvatar = useCallback(async () => {
    setSaveError('')
    const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (permissionResult.status !== 'granted') {
      setSaveError('Photo library permission is required to choose an avatar.')
      return
    }

    const pickerResult = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      base64: true,
    })
    if (pickerResult.canceled || !pickerResult.assets?.[0]) return

    const selectedAsset = pickerResult.assets[0]
    if (!selectedAsset.base64) {
      setSaveError('Unable to read selected image.')
      return
    }
    setAvatarBase64(selectedAsset.base64)
    setAvatarPreviewUrl(selectedAsset.uri)
  }, [])

  const saveChannelChanges = useCallback(async () => {
    if (isSaving) return
    setIsSaving(true)
    setSaveError('')
    try {
      if (avatarBase64) {
        const avatarUpdateResponse = await (rpc as any).updateChannelAvatar({
          imageData: avatarBase64,
          mimeType: 'image/jpeg',
        })
        if (avatarUpdateResponse?.avatarUrl) setAvatarPreviewUrl(avatarUpdateResponse.avatarUrl)
      }
      await (rpc as any).updateChannel({
        name: editName.trim(),
        description: editDescription.trim(),
      })
      await loadCatalog()
      setIsEditModalVisible(false)
      setAvatarBase64('')
    } catch (channelSaveError: any) {
      setSaveError(channelSaveError?.message || 'Failed to save channel changes.')
    } finally {
      setIsSaving(false)
    }
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

      {catalogState.catalogLoading ? (
        <ScrollView contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false}>
          <ChannelPageSkeleton />
        </ScrollView>
      ) : catalogState.catalogError && !catalogView ? (
        <View className="flex-1 px-8 items-center justify-center">
          <Feather name="alert-circle" size={36} color={colors.error} />
          <Text className="text-body text-pear-text mt-4 text-center" selectable>{catalogState.catalogError}</Text>
          <PressableFeedback onPress={loadCatalog} className="mt-5 bg-pear-primary rounded-lg px-5 py-3" accessibilityRole="button">
            <Text className="text-label" style={{ color: colors.onPrimary }}>Retry</Text>
          </PressableFeedback>
        </View>
      ) : (
        <FlatList
          data={groupedCards}
          keyExtractor={(card) => card.id}
          renderItem={renderCatalogCard}
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          ListHeaderComponent={(
            <>
              {bannerUrl ? (
                <Image
                  source={{ uri: bannerUrl }}
                  style={styles.bannerImage}
                  resizeMode="cover"
                  onError={() => {
                    const artwork = profileArtworkCache.banner
                    if (!artwork?.url) return
                    void resolveProfileArtwork(
                      'banner',
                      artwork.nextIndex,
                      artwork.provisional,
                      [...artwork.failedUrls, artwork.url],
                    )
                  }}
                />
              ) : null}
              <View style={styles.hero}>
                <View style={styles.avatarShell}>
                  {activeAvatarUrl ? (
                    <Image
                      source={{ uri: activeAvatarUrl }}
                      style={styles.avatarImage}
                      resizeMode="cover"
                      onError={avatarPreviewUrl ? undefined : () => {
                        const artwork = profileArtworkCache.avatar
                        if (!artwork?.url) return
                        void resolveProfileArtwork(
                          'avatar',
                          artwork.nextIndex,
                          artwork.provisional,
                          [...artwork.failedUrls, artwork.url],
                        )
                      }}
                    />
                  ) : (
                    <Text style={styles.avatarInitial}>{channelDisplayName.charAt(0).toUpperCase() || 'P'}</Text>
                  )}
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

                {isOwner ? (
                  <PressableFeedback onPress={openEditModal} className="mt-5 rounded-full px-4 py-3 flex-row items-center justify-center gap-2" accessibilityRole="button">
                    <Feather name="edit-2" size={16} color={colors.text} />
                    <Text style={styles.editButtonText}>Edit Channel</Text>
                  </PressableFeedback>
                ) : (
                  <View style={styles.heroActions}>
                    <Pressable
                      onPress={toggleSubscribe}
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
                      onPress={togglePin}
                      accessibilityRole="button"
                      accessibilityLabel={isPinned ? 'Stop keeping this channel online' : 'Keep this channel online'}
                      style={({ pressed }) => [styles.pinButton, isPinned && styles.pinButtonActive, pressed && { opacity: 0.75 }]}
                    >
                      <Feather name="anchor" size={15} color={isPinned ? colors.onPrimary : colors.textSecondary} />
                    </Pressable>
                  </View>
                )}
              </View>

              {catalogView?.tabs.length ? (
                <View style={styles.tabRow}>
                  {catalogView.tabs.map((tab) => {
                    const active = tab.id === selectedGroupId
                    return (
                      <Pressable
                        key={tab.id}
                        onPress={() => selectGroup(tab.id)}
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
              ) : null}

              <View style={styles.sectionHeading}>
                <Text style={styles.sectionTitle}>{selectedTab?.sectionLabel || 'Latest'}</Text>
              </View>
              {selectedPage.error ? (
                <View style={styles.inlineError}>
                  <Text className="text-body text-pear-text-secondary" selectable>{selectedPage.error}</Text>
                  <PressableFeedback onPress={retrySelectedGroup} className="mt-3 self-start bg-pear-primary rounded-lg px-4 py-2" accessibilityRole="button">
                    <Text className="text-label" style={{ color: colors.onPrimary }}>Retry</Text>
                  </PressableFeedback>
                </View>
              ) : null}
            </>
          )}
          ListEmptyComponent={selectedPage.loading ? (
            <View style={styles.emptyState}>
              <ActivityIndicator color={colors.primary} />
              <Text className="text-body text-pear-text-secondary mt-3">Loading {selectedTab?.label || 'videos'}...</Text>
            </View>
          ) : selectedPage.error ? null : (
            <View style={styles.emptyState}>
              <Feather name="video-off" size={30} color={colors.textMuted} />
              <Text className="text-body text-pear-text-secondary mt-3">No videos yet</Text>
            </View>
          )}
          ListFooterComponent={selectedPage.nextCursor ? (
            <Pressable
              onPress={loadMore}
              disabled={selectedPage.loadingMore}
              accessibilityRole="button"
              style={({ pressed }) => [styles.loadMoreButton, (pressed || selectedPage.loadingMore) && { opacity: 0.75 }]}
            >
              {selectedPage.loadingMore ? <ActivityIndicator size="small" color={colors.onPrimary} /> : null}
              <Text style={styles.loadMoreLabel}>{selectedPage.loadingMore ? 'Loading...' : 'Load more'}</Text>
            </Pressable>
          ) : null}
        />
      )}

      <Modal visible={isEditModalVisible} animationType="slide" transparent onRequestClose={closeEditModal}>
        <View className="flex-1 bg-black/70 justify-end">
          <View className="bg-pear-bg-card rounded-t-3xl max-h-[90%] border-t border-pear-border">
            <View className="px-5 py-4 border-b border-pear-border flex-row items-center justify-between">
              <Text className="text-headline text-pear-text">Edit Channel</Text>
              <PressableFeedback onPress={closeEditModal} className="w-9 h-9 rounded-full bg-pear-bg-input items-center justify-center" accessibilityRole="button">
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
                onChangeText={setEditName}
                placeholderTextColor={colors.textMuted}
                className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3.5 text-body text-pear-text"
              />

              <View className="mt-4">
                <Text className="text-label text-pear-text mb-1.5">Description</Text>
                <NativeTextInput
                  value={editDescription}
                  onChangeText={setEditDescription}
                  placeholderTextColor={colors.textMuted}
                  multiline
                  textAlignVertical="top"
                  className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3.5 text-body text-pear-text min-h-28"
                />
              </View>

              <View className="mt-4">
                <NativeButton label="Choose Avatar" onPress={pickAvatar} variant="outlined" style={nativeFormButtonStyle} />
              </View>

              {saveError ? <Text className="text-pear-error text-caption mt-3">{saveError}</Text> : null}
            </ScrollView>

            <View className="px-5 py-4 border-t border-pear-border flex-row gap-3">
              <NativeButton label="Cancel" onPress={closeEditModal} disabled={isSaving} variant="outlined" style={nativeFormButtonStyle} />
              <NativeButton label={isSaving ? 'Saving...' : 'Save'} onPress={saveChannelChanges} disabled={isSaving} variant="filled" style={nativeFormButtonStyle} />
            </View>
          </View>
        </View>
      </Modal>
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
