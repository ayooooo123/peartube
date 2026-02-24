import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Modal,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  View,
  ActivityIndicator,
  Pressable,
  Image,
  type PressableProps,
} from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import * as ImagePicker from 'expo-image-picker'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { rpc } from '@peartube/platform/rpc'
import { Skeleton } from '@/components/ui/skeleton'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { colors } from '@/lib/colors'

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

function PressableFeedback({ children, className, ...props }: PressableProps) {
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

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }))

  return (
    <AnimatedPressable
      {...props}
      className={className}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
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
}: {
  video: ChannelVideo
  channelName: string
}) {
  return (
    <PressableFeedback className="mb-4" onPress={() => {}} accessibilityRole="button">
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
  const { key } = useLocalSearchParams<{ key: string | string[] }>()
  const channelKey = useMemo(() => (Array.isArray(key) ? key[0] : key) || '', [key])

  const [channelMeta, setChannelMeta] = useState<ChannelMeta | null>(null)
  const [channelVideos, setChannelVideos] = useState<ChannelVideo[]>([])
  const [identityDriveKey, setIdentityDriveKey] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [screenError, setScreenError] = useState('')

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

  const fetchChannelPage = useCallback(async () => {
    if (!channelKey) {
      setScreenError('Missing channel key.')
      setIsLoading(false)
      return
    }

    try {
      setScreenError('')
      setIsLoading(true)
      const [channelMetaResponse, channelVideosResponse] = await Promise.all([
        rpc.getChannelMeta({ channelKey }),
        rpc.listVideos({ channelKey }),
      ])
      setChannelMeta(channelMetaResponse || null)
      setChannelVideos(Array.isArray(channelVideosResponse?.videos) ? channelVideosResponse.videos : [])
    } catch (channelFetchError: any) {
      setScreenError(channelFetchError?.message || 'Failed to load channel page.')
    } finally {
      setIsLoading(false)
    }
  }, [channelKey])

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
      allowsEditing: true,
      quality: 0.8,
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
    <SafeAreaView className="flex-1 bg-pear-bg">
      <View className="flex-row items-center px-5 py-4 border-b border-pear-border">
        <PressableFeedback
          onPress={() => router.back()}
          className="w-10 h-10 rounded-full bg-pear-bg-card items-center justify-center mr-3"
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Feather name="chevron-left" size={20} color={colors.text} />
        </PressableFeedback>
        <Text className="text-headline text-pear-text" numberOfLines={1}>Channel</Text>
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
          contentContainerStyle={{ paddingBottom: 28 }}
        >
          <View className="px-5 pt-4 pb-2">
            <View className="flex-row items-center">
              {activeAvatarUrl ? (
                <Image source={{ uri: activeAvatarUrl }} className="w-20 h-20 rounded-full bg-pear-bg-card" resizeMode="cover" />
              ) : (
                <View className="w-20 h-20 rounded-full bg-pear-primary items-center justify-center">
                  <Text className="text-white text-title font-bold">{channelDisplayName.charAt(0).toUpperCase() || 'P'}</Text>
                </View>
              )}

              <View className="flex-1 ml-4">
                <Text className="text-title text-pear-text font-bold" numberOfLines={2} selectable>{channelDisplayName}</Text>
                <Text className="text-body text-pear-text-secondary mt-1" selectable>{channelDescription}</Text>
              </View>
            </View>

            {isOwner ? (
              <PressableFeedback
                onPress={openEditModal}
                className="mt-4 bg-pear-bg-card border border-pear-border rounded-lg px-4 py-3 flex-row items-center justify-center gap-2"
                accessibilityRole="button"
              >
                <Feather name="edit-2" size={16} color={colors.text} />
                <Text className="text-label text-pear-text">Edit Channel</Text>
              </PressableFeedback>
            ) : null}
          </View>

          <View className="px-5 pt-4">
            {channelVideos.length === 0 ? (
              <View className="py-16 items-center justify-center rounded-xl bg-pear-bg-card border border-pear-border">
                <Feather name="video-off" size={30} color={colors.textMuted} />
                <Text className="text-body text-pear-text-secondary mt-3">No videos yet</Text>
              </View>
            ) : (
              channelVideos.map((channelVideo) => (
                <ChannelVideoCard key={channelVideo.id} video={channelVideo} channelName={channelDisplayName} />
              ))
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
