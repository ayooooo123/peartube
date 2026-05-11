import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Modal,
  ScrollView,
  Text,
  TextInput,
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
import { rpc } from '@peartube/platform/rpc'
import { Skeleton } from '@/components/ui/skeleton'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { colors } from '@/lib/colors'

const CHANNEL_PAGE_RPC_TIMEOUT_MS = 4500

type ChannelPageTimeoutResult = { timedOut: true }

function withChannelPageTimeout<T>(promise: Promise<T>, ms = CHANNEL_PAGE_RPC_TIMEOUT_MS): Promise<T | ChannelPageTimeoutResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.finally(() => {
      if (timeout) clearTimeout(timeout)
    }),
    new Promise<ChannelPageTimeoutResult>((resolve) => {
      timeout = setTimeout(() => resolve({ timedOut: true }), ms)
    }),
  ])
}

function isTimedOutResult(result: unknown): result is { timedOut: true } {
  return Boolean(result && typeof result === 'object' && (result as any).timedOut === true)
}

type ChannelMeta = {
  name?: string
  description?: string
  avatar?: string
}

type ChannelVideo = {
  id: string
  title: string
  description?: string
  uploadedAt?: number
  createdAt?: number
  thumbnailUrl?: string | null
  thumbnail?: string | null
  duration?: number
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
}: {
  video: ChannelVideo
  channelName: string
  onPress: () => void
}) {
  return (
    <PressableFeedback className="mb-4" onPress={onPress} accessibilityRole="button" enableMotion={false}>
      <ThumbnailImage
        thumbnailUrl={video.thumbnailUrl || video.thumbnail}
        duration={video.duration}
        channelInitial={channelName.charAt(0).toUpperCase() || 'P'}
      />
      <View className="flex-row mt-3 px-3">
        <View className="w-10 h-10 rounded-full bg-pear-primary items-center justify-center mr-3">
          <Text className="text-white text-label font-semibold">{channelName.charAt(0).toUpperCase() || 'P'}</Text>
        </View>
        <View className="flex-1">
          <Text className="text-label text-pear-text" numberOfLines={2}>{video.title || 'Untitled video'}</Text>
          <Text className="text-caption text-pear-text-secondary mt-1" numberOfLines={1}>
            {channelName} · {formatVideoTime(video.uploadedAt || video.createdAt)}
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
  const [channelMeta, setChannelMeta] = useState<ChannelMeta | null>(null)
  const [channelVideos, setChannelVideos] = useState<ChannelVideo[]>([])
  const [thumbnailCache, setThumbnailCache] = useState<Record<string, string>>({})
  const [identityDriveKey, setIdentityDriveKey] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [screenError, setScreenError] = useState('')
  const [videosDegradedMessage, setVideosDegradedMessage] = useState('')

  const [isEditModalVisible, setIsEditModalVisible] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState('')
  const [avatarBase64, setAvatarBase64] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const isOwner = identityDriveKey === channelKey
  const activeAvatarUrl = avatarPreviewUrl || channelMeta?.avatar || ''
  const channelDisplayName = channelMeta?.name?.trim() || `Channel ${channelKey.slice(0, 8)}`
  const channelDescription = channelMeta?.description?.trim() || 'No channel description yet.'
  const channelVideoCountText = `${channelVideos.length} ${channelVideos.length === 1 ? 'video' : 'videos'}`

  const resolveChannelThumbnails = useCallback((videosToResolve: ChannelVideo[]) => {
    if (!appRpc || !channelKey || videosToResolve.length === 0) return

    for (const video of videosToResolve) {
      if (!video?.id) continue
      const cacheKey = `${channelKey}:${video.id}`
      if (video.thumbnailUrl || video.thumbnail) continue

      void fetchThumbnailUrlWithRetry({
        rpc: appRpc,
        channelKey,
        videoId: video.id,
        expectedPort: blobServerPort,
      }).then((url) => {
        if (!url) return
        setThumbnailCache((prev) => {
          if (prev[cacheKey] === url) return prev
          return { ...prev, [cacheKey]: url }
        })
      })
    }
  }, [appRpc, blobServerPort, channelKey])

  const fetchChannelPage = useCallback(async () => {
    if (!channelKey) {
      setScreenError('Missing channel key.')
      setIsLoading(false)
      return
    }

    try {
      setScreenError('')
      setIsLoading(true)
      setVideosDegradedMessage('')
      const [channelMetaSettled, channelVideosSettled] = await Promise.allSettled([
        withChannelPageTimeout(rpc.getChannelMeta({ channelKey, publicBeeKey: channelPublicBeeKey || undefined } as any)),
        withChannelPageTimeout(rpc.listVideos({ channelKey, publicBeeKey: channelPublicBeeKey || undefined } as any)),
      ])

      const metaResult = channelMetaSettled.status === 'fulfilled' ? channelMetaSettled.value : null
      if (!isTimedOutResult(metaResult) && metaResult) {
        setChannelMeta(metaResult)
      }

      const videosResult = channelVideosSettled.status === 'fulfilled' ? channelVideosSettled.value : null
      if (isTimedOutResult(videosResult)) {
        setVideosDegradedMessage('Video list is taking longer than expected. Showing any cached channel details; retry to refresh videos.')
      } else if (channelVideosSettled.status === 'rejected') {
        setVideosDegradedMessage(channelVideosSettled.reason?.message || 'Failed to load videos. Retry to refresh this channel.')
      } else if ((videosResult as any)?.success === false) {
        setVideosDegradedMessage((videosResult as any)?.error || 'Failed to load videos. Retry to refresh this channel.')
      } else {
        const loadedVideos = Array.isArray((videosResult as any)?.videos) ? (videosResult as any).videos : []
        setChannelVideos(loadedVideos)
        resolveChannelThumbnails(loadedVideos)
      }

      if (channelMetaSettled.status === 'rejected' && channelVideosSettled.status === 'rejected') {
        setScreenError(channelMetaSettled.reason?.message || channelVideosSettled.reason?.message || 'Failed to load channel page.')
      }
    } catch (channelFetchError: any) {
      setScreenError(channelFetchError?.message || 'Failed to load channel page.')
    } finally {
      setIsLoading(false)
    }
  }, [channelKey, channelPublicBeeKey, resolveChannelThumbnails])

  useEffect(() => {
    let isMounted = true

    const loadIdentity = async () => {
      try {
        const currentIdentity = await rpc.getIdentity()
        if (isMounted) {
          setIdentityDriveKey(currentIdentity?.driveKey || '')
        }
      } catch {
        if (isMounted) {
          setIdentityDriveKey('')
        }
      }
    }

    loadIdentity()
    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    fetchChannelPage()
  }, [fetchChannelPage])

  const openEditModal = useCallback(() => {
    setSaveError('')
    setAvatarBase64('')
    setAvatarPreviewUrl(channelMeta?.avatar || '')
    setEditName(channelMeta?.name || '')
    setEditDescription(channelMeta?.description || '')
    setIsEditModalVisible(true)
  }, [channelMeta?.avatar, channelMeta?.description, channelMeta?.name])

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

    if (pickerResult.canceled || !pickerResult.assets?.[0]) {
      return
    }

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

        if (avatarUpdateResponse?.avatarUrl) {
          setAvatarPreviewUrl(avatarUpdateResponse.avatarUrl)
        }
      }

      await (rpc as any).updateChannel({
        name: editName.trim(),
        description: editDescription.trim(),
      })

      await fetchChannelPage()
      setIsEditModalVisible(false)
      setAvatarBase64('')
    } catch (channelSaveError: any) {
      setSaveError(channelSaveError?.message || 'Failed to save channel changes.')
    } finally {
      setIsSaving(false)
    }
  }, [avatarBase64, editDescription, editName, fetchChannelPage, isSaving])

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

      {isLoading ? (
        <ScrollView contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false}>
          <ChannelPageSkeleton />
        </ScrollView>
      ) : screenError ? (
        <View className="flex-1 px-8 items-center justify-center">
          <Feather name="alert-circle" size={36} color={colors.error} />
          <Text className="text-body text-pear-text mt-4 text-center" selectable>{screenError}</Text>
          <PressableFeedback
            onPress={fetchChannelPage}
            className="mt-5 bg-pear-primary rounded-lg px-5 py-3"
            accessibilityRole="button"
          >
            <Text className="text-white text-label">Retry</Text>
          </PressableFeedback>
        </View>
      ) : (
            <ScrollView
              contentInsetAdjustmentBehavior="automatic"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.scrollContent}
            >
              <View style={styles.hero}>
                <View style={styles.avatarShell}>
                  {activeAvatarUrl ? (
                    <Image source={{ uri: activeAvatarUrl }} style={styles.avatarImage} resizeMode="cover" />
                  ) : (
                    <Text style={styles.avatarInitial}>{channelDisplayName.charAt(0).toUpperCase() || 'P'}</Text>
                  )}
                </View>

                <View style={styles.heroCopy}>
                  <Text style={styles.channelTitle} numberOfLines={2} selectable>{channelDisplayName}</Text>
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
                  <PressableFeedback
                    onPress={openEditModal}
                    className="mt-5 rounded-full px-4 py-3 flex-row items-center justify-center gap-2"
                    accessibilityRole="button"
                  >
                    <Feather name="edit-2" size={16} color={colors.text} />
                    <Text style={styles.editButtonText}>Edit Channel</Text>
                  </PressableFeedback>
                ) : null}
              </View>

              <View style={styles.videoListSection}>
            {videosDegradedMessage ? (
              <View className="mb-4 rounded-xl bg-pear-bg-card border border-pear-border px-4 py-3">
                <Text className="text-body text-pear-text-secondary" selectable>{videosDegradedMessage}</Text>
                <PressableFeedback
                  onPress={fetchChannelPage}
                  className="mt-3 self-start bg-pear-primary rounded-lg px-4 py-2"
                  accessibilityRole="button"
                >
                  <Text className="text-white text-label">Retry</Text>
                </PressableFeedback>
              </View>
            ) : null}
            {channelVideos.length === 0 && !videosDegradedMessage ? (
              <View className="py-16 items-center justify-center rounded-xl bg-pear-bg-card border border-pear-border">
                <Feather name="video-off" size={30} color={colors.textMuted} />
                <Text className="text-body text-pear-text-secondary mt-3">No videos yet</Text>
              </View>
            ) : (
              channelVideos.map((channelVideo) => {
                const thumbnailUrl = thumbnailCache[`${channelKey}:${channelVideo.id}`] || channelVideo.thumbnailUrl || channelVideo.thumbnail || null
                return (
                  <ChannelVideoCard
                    key={channelVideo.id}
                    video={{ ...channelVideo, thumbnailUrl }}
                    channelName={channelDisplayName}
                    onPress={() => router.push({
                      pathname: '/video/[id]',
                      params: {
                        id: channelVideo.id,
                        channel: channelKey,
                        publicBeeKey: channelPublicBeeKey || undefined,
                        videoData: JSON.stringify({
                          ...channelVideo,
                          thumbnailUrl,
                          channelKey,
                          publicBeeKey: channelPublicBeeKey || undefined,
                          channel: { name: channelDisplayName },
                        }),
                      },
                    })}
                  />
                )
              })
            )}
          </View>
        </ScrollView>
      )}

      <Modal
        visible={isEditModalVisible}
        animationType="slide"
        transparent
        onRequestClose={closeEditModal}
      >
        <View className="flex-1 bg-black/70 justify-end">
          <View className="bg-pear-bg-card rounded-t-3xl max-h-[90%] border-t border-pear-border">
            <View className="px-5 py-4 border-b border-pear-border flex-row items-center justify-between">
              <Text className="text-headline text-pear-text">Edit Channel</Text>
              <PressableFeedback
                onPress={closeEditModal}
                className="w-9 h-9 rounded-full bg-pear-bg-input items-center justify-center"
                accessibilityRole="button"
              >
                <Feather name="x" size={18} color={colors.text} />
              </PressableFeedback>
            </View>

            <ScrollView
              contentInsetAdjustmentBehavior="automatic"
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 20 }}
            >
              <Text className="text-label text-pear-text mb-1.5">Channel Name</Text>
              <TextInput
                className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3.5 text-body text-pear-text"
                placeholderTextColor={colors.textMuted}
                value={editName}
                onChangeText={setEditName}
              />

              <View className="mt-4">
                <Text className="text-label text-pear-text mb-1.5">Description</Text>
                <TextInput
                  className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3.5 text-body text-pear-text min-h-28"
                  placeholderTextColor={colors.textMuted}
                  value={editDescription}
                  onChangeText={setEditDescription}
                  multiline
                  textAlignVertical="top"
                />
              </View>

              <View className="mt-4">
                <PressableFeedback
                  onPress={pickAvatar}
                  className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3 flex-row items-center justify-center gap-2"
                  accessibilityRole="button"
                >
                  <Feather name="image" size={16} color={colors.text} />
                  <Text className="text-label text-pear-text">Choose Avatar</Text>
                </PressableFeedback>
              </View>

              {saveError ? <Text className="text-pear-error text-caption mt-3">{saveError}</Text> : null}
            </ScrollView>

            <View className="px-5 py-4 border-t border-pear-border flex-row gap-3">
              <PressableFeedback
                onPress={closeEditModal}
                className={`flex-1 rounded-lg py-3 items-center justify-center bg-pear-bg-input border border-pear-border ${isSaving ? 'opacity-50' : ''}`}
                disabled={isSaving}
                accessibilityRole="button"
              >
                <Text className="text-label text-pear-text">Cancel</Text>
              </PressableFeedback>

              <PressableFeedback
                onPress={saveChannelChanges}
                className={`flex-1 rounded-lg py-3 items-center justify-center bg-pear-primary flex-row gap-2 ${isSaving ? 'opacity-50' : ''}`}
                disabled={isSaving}
                accessibilityRole="button"
              >
                {isSaving ? <ActivityIndicator color="white" size="small" /> : null}
                <Text className="text-label text-white">Save</Text>
              </PressableFeedback>
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
    color: '#fff',
    fontSize: 30,
    fontWeight: '700',
  },
  heroCopy: {
    gap: 8,
  },
  channelTitle: {
    color: colors.text,
    fontSize: 28,
    lineHeight: 33,
    fontWeight: '700',
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
  videoListSection: {
    paddingTop: 18,
  },
})
