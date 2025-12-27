/**
 * Studio Tab - Upload and manage videos
 */
import { useState, useCallback } from 'react'
import { View, Text, FlatList, Alert, Pressable, TextInput, ActivityIndicator, Platform, Image } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather, Ionicons } from '@expo/vector-icons'
import * as ImagePicker from 'expo-image-picker'
import * as VideoThumbnails from 'expo-video-thumbnails'
import { useApp, colors } from '../_layout'

// Helper to read file as base64 without expo-file-system
async function readFileAsBase64(uri: string): Promise<string> {
  const response = await fetch(uri)
  const blob = await response.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(',')[1] // Remove data:... prefix
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// Detect Pear desktop (web platform with PearWorkerClient)
const isPear = Platform.OS === 'web' && typeof window !== 'undefined' && !!(window as any).PearWorkerClient

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleDateString()
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

export default function StudioScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { identity, videos, rpc, uploadVideo, pickVideoFile, pickImageFile, loadVideos } = useApp()
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadSpeed, setUploadSpeed] = useState(0)  // bytes/sec
  const [uploadEta, setUploadEta] = useState(0)      // seconds remaining
  const [isTranscoding, setIsTranscoding] = useState(false)  // true during audio transcode phase
  const [title, setTitle] = useState('')
  const [selectedVideo, setSelectedVideo] = useState<string | null>(null)
  const [selectedCategory, setSelectedCategory] = useState('Other')
  const categoryOptions = ['Music', 'Gaming', 'Tech', 'Education', 'Entertainment', 'Vlog', 'Other']
  const [filePath, setFilePath] = useState<string | null>(null) // Pear: actual file path
  const [fileSize, setFileSize] = useState<number>(0)
  const [mimeType, setMimeType] = useState<string>('video/mp4')
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(null) // Preview URI (data URL or file URI)
  const [thumbnailFilePath, setThumbnailFilePath] = useState<string | null>(null) // Pear: actual thumbnail file path
  const [videoDuration, setVideoDuration] = useState<number | null>(null)

  // Generate thumbnail from video at 10%
  const generateThumbnail = useCallback(async (videoUri: string, durationMs?: number) => {
    if (isPear) return // Desktop handles thumbnails server-side
    try {
      const timeMs = durationMs ? Math.floor(durationMs * 0.1) : 1000
      console.log('[Studio] Generating thumbnail at', timeMs, 'ms')
      const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
        time: timeMs,
        quality: 0.8,
      })
      console.log('[Studio] Thumbnail generated:', uri)
      setThumbnailUri(uri)
      return uri
    } catch (err) {
      console.log('[Studio] Thumbnail generation failed:', err)
      return null
    }
  }, [])

  // Pick custom thumbnail image
  const pickThumbnail = useCallback(async () => {
    console.log('[Studio] pickThumbnail called, isPear:', isPear)
    if (isPear) {
      // Pear desktop: use native file picker
      try {
        console.log('[Studio] Opening native image file picker...')
        const result = await pickImageFile()
        console.log('[Studio] pickImageFile result:', JSON.stringify(result))

        if (!result) {
          console.log('[Studio] Image picker not available')
          return
        }

        if ('cancelled' in result && result.cancelled) {
          console.log('[Studio] Image picker cancelled')
          return
        }

        if ('filePath' in result) {
          console.log('[Studio] Thumbnail selected:', result.filePath)
          // Store file path for upload and dataUrl for preview
          setThumbnailFilePath(result.filePath)
          console.log('[Studio] setThumbnailFilePath called with:', result.filePath)
          if (result.dataUrl) {
            setThumbnailUri(result.dataUrl)
            console.log('[Studio] setThumbnailUri called with dataUrl (length:', result.dataUrl.length, ')')
          }
        }
      } catch (err: any) {
        console.error('[Studio] Image picker error:', err)
        Alert.alert('Error', err.message || 'Failed to open image picker')
      }
      return
    }

    // Native: use expo-image-picker
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please grant permission to access your photos')
      return
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [16, 9],
      quality: 0.8,
    })

    if (!result.canceled && result.assets[0]) {
      console.log('[Studio] Custom thumbnail selected:', result.assets[0].uri)
      setThumbnailUri(result.assets[0].uri)
    }
  }, [pickImageFile])

  const pickVideo = async () => {
    if (isPear) {
      // Pear desktop: use native file picker via osascript
      try {
        console.log('[Studio] Opening native file picker...')
        const result = await pickVideoFile()

        if (!result) {
          console.log('[Studio] File picker not available')
          Alert.alert('Not available', 'Native file picker is not available')
          return
        }

        if ('cancelled' in result && result.cancelled) {
          console.log('[Studio] File picker cancelled')
          return
        }

        if ('filePath' in result) {
          console.log('[Studio] File selected:', result.filePath, 'size:', result.size)
          setFilePath(result.filePath)
          setSelectedVideo(result.filePath) // Use path as identifier
          // Use filename for title (without extension)
          setTitle(result.name.replace(/\.[^/.]+$/, ''))
          setFileSize(result.size)
          setMimeType('video/mp4') // Default, worker will detect
        }
      } catch (err: any) {
        console.error('[Studio] File picker error:', err)
        Alert.alert('Error', err.message || 'Failed to open file picker')
      }
      return
    }

    // Native: use expo-image-picker
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please grant permission to access your videos')
      return
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      allowsEditing: false,
      quality: 1,
    })

    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0]
      setSelectedVideo(asset.uri)
      const filename = asset.uri.split('/').pop() || 'Untitled'
      setTitle(filename.replace(/\.[^/.]+$/, ''))

      // Store duration if available
      if (asset.duration) {
        setVideoDuration(asset.duration)
      }

      // Generate thumbnail at 10% into video
      await generateThumbnail(asset.uri, asset.duration)
    }
  }

  const handleUpload = async () => {
    console.log('[Studio] handleUpload called:', {
      selectedVideo: !!selectedVideo,
      title: title.trim(),
      identity: !!identity,
      filePath: !!filePath,
      thumbnailFilePath: thumbnailFilePath || 'none',
      thumbnailUri: thumbnailUri || 'none',
    })

    if (!selectedVideo) {
      Alert.alert('No video selected', 'Please select a video to upload')
      return
    }
    if (!title.trim()) {
      Alert.alert('Title required', 'Please enter a title for your video')
      return
    }
    if (!identity) {
      console.error('[Studio] No identity! Please create one in Settings first')
      Alert.alert('No identity', 'Please create an identity in Settings first')
      return
    }

    setUploading(true)
    setUploadProgress(0)

    try {
      let videoId: string | null = null

      if (isPear && filePath) {
        // Pear desktop: use file path based upload via uploadVideo from context
        // Skip FFmpeg thumbnail generation if user selected a custom thumbnail
        const skipThumbnail = !!thumbnailFilePath
        console.log('[Studio] Uploading via Pear:', filePath, 'category:', selectedCategory, 'skipThumbnail:', skipThumbnail)
        const video = await uploadVideo(filePath, title.trim(), '', mimeType, selectedCategory, (progress, speed, eta, transcoding) => {
          setUploadProgress(progress)
          if (speed !== undefined) setUploadSpeed(speed)
          if (eta !== undefined) setUploadEta(eta)
          setIsTranscoding(!!transcoding)
        }, skipThumbnail)
        videoId = video?.id

        // If we have a thumbnail selected, upload it
        if (thumbnailFilePath && videoId && rpc) {
          console.log('[Studio] Uploading thumbnail from file:', thumbnailFilePath)
          try {
            await rpc.setVideoThumbnailFromFile({
              videoId,
              filePath: thumbnailFilePath,
            })
            console.log('[Studio] Thumbnail uploaded from file')
          } catch (thumbErr) {
            console.error('[Studio] Failed to upload thumbnail:', thumbErr)
            // Don't fail the whole upload if thumbnail fails
          }
        }

        // Reload videos after upload
        await loadVideos(identity.driveKey)
      } else if (rpc) {
        // Native: use HRPC upload
        // Skip FFmpeg thumbnail generation if user selected/generated a thumbnail
        const skipThumbnail = !!thumbnailUri
        const result = await rpc.uploadVideo({
          filePath: selectedVideo,
          title: title.trim(),
          description: '',
          category: selectedCategory,
          skipThumbnailGeneration: skipThumbnail,
        })
        videoId = result?.video?.id
        console.log('[Studio] Upload complete, videoId:', videoId, 'skippedThumbnail:', skipThumbnail)

        // If we have a thumbnail, upload it
        if (thumbnailUri && videoId) {
          console.log('[Studio] Uploading thumbnail from URI:', thumbnailUri)
          try {
            const thumbBase64 = await readFileAsBase64(thumbnailUri)
            console.log('[Studio] Thumbnail base64 length:', thumbBase64.length)

            const uploadResult = await rpc.setVideoThumbnail({
              videoId,
              imageData: thumbBase64,
              mimeType: 'image/jpeg',
            })
            console.log('[Studio] Thumbnail upload result:', JSON.stringify(uploadResult))
          } catch (thumbErr: any) {
            console.error('[Studio] Failed to upload thumbnail:', thumbErr?.message || thumbErr)
            // Don't fail the whole upload if thumbnail fails
          }
        } else {
          console.log('[Studio] No thumbnail to upload, thumbnailUri:', thumbnailUri, 'videoId:', videoId)
        }

        await loadVideos(identity.driveKey)
      }

      setSelectedVideo(null)
      setFilePath(null)
      setTitle('')
      setFileSize(0)
      setThumbnailUri(null)
      setThumbnailFilePath(null)
      setVideoDuration(null)
      setSelectedCategory('Other')
      Alert.alert('Success', 'Video uploaded successfully!')
    } catch (err: any) {
      console.error('[Studio] Upload failed:', err)
      Alert.alert('Upload failed', err.message || 'Failed to upload video')
    } finally {
      setUploading(false)
      setUploadProgress(0)
      setUploadSpeed(0)
      setUploadEta(0)
      setIsTranscoding(false)
    }
  }

  const myVideos = videos.filter((v) => v.channelKey === identity?.driveKey)

  const handleDeleteVideo = async (videoId: string, videoTitle: string) => {
    const confirmDelete = () => {
      return new Promise<boolean>((resolve) => {
        if (Platform.OS === 'web') {
          resolve(window.confirm(`Delete "${videoTitle}"?\n\nThis will permanently delete the video from your channel.`))
        } else {
          Alert.alert(
            'Delete Video',
            `Delete "${videoTitle}"?\n\nThis will permanently delete the video from your channel.`,
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
              { text: 'Delete', style: 'destructive', onPress: () => resolve(true) },
            ]
          )
        }
      })
    }

    const confirmed = await confirmDelete()
    if (!confirmed) return

    try {
      const result = await rpc?.deleteVideo({ videoId })
      if (result?.success) {
        // Reload videos after deletion
        if (identity?.driveKey) {
          await loadVideos(identity.driveKey)
        }
        if (Platform.OS === 'web') {
          window.alert('Video deleted successfully')
        } else {
          Alert.alert('Deleted', 'Video deleted successfully')
        }
      } else {
        const errorMsg = result?.error || 'Failed to delete video'
        if (Platform.OS === 'web') {
          window.alert(`Error: ${errorMsg}`)
        } else {
          Alert.alert('Error', errorMsg)
        }
      }
    } catch (err: any) {
      console.error('[Studio] Delete failed:', err)
      const errorMsg = err.message || 'Failed to delete video'
      if (Platform.OS === 'web') {
        window.alert(`Error: ${errorMsg}`)
      } else {
        Alert.alert('Error', errorMsg)
      }
    }
  }

  return (
    <View className="flex-1 bg-pear-bg">
      {/* Header with safe area */}
      <View
        className="bg-pear-bg border-b border-pear-border"
        style={{ paddingTop: insets.top }}
      >
        <View className="px-5 py-4">
          <View className="flex-row items-center justify-between">
            <Text className="text-title text-pear-text">Studio</Text>
            <Pressable onPress={() => router.push('/search')} className="p-2">
              <Feather name="search" color={colors.text} size={18} />
            </Pressable>
          </View>
          <Text className="text-caption text-pear-text-muted mt-1">
            {identity ? `Channel: ${identity.name}` : 'No identity - create one in Settings'}
          </Text>
        </View>
      </View>

      {/* Upload Section */}
      <View className="px-5 py-5 border-b border-pear-border">
        {selectedVideo ? (
          <View className="gap-4">
            {/* Thumbnail preview */}
            <View className="rounded-xl overflow-hidden bg-pear-bg-card">
              <View style={{ aspectRatio: 16 / 9 }}>
                {thumbnailUri ? (
                  <Image
                    source={{ uri: thumbnailUri }}
                    style={{ width: '100%', height: '100%' }}
                    resizeMode="cover"
                  />
                ) : (
                  <View className="flex-1 items-center justify-center bg-pear-bg-elevated">
                    <Feather name="film" color={colors.textMuted} size={48} />
                    <Text className="text-caption text-pear-text-muted mt-2">
                      {isPear ? 'Click below to add thumbnail' : 'Generating thumbnail...'}
                    </Text>
                  </View>
                )}
              </View>
              {/* Change thumbnail button */}
              <Pressable
                onPress={pickThumbnail}
                className="flex-row items-center justify-center gap-2 py-3 bg-pear-bg-elevated active:opacity-80"
              >
                <Feather name="image" color={colors.textMuted} size={16} />
                <Text className="text-caption text-pear-text-muted">
                  {thumbnailUri ? 'Change Thumbnail' : 'Add Thumbnail'}
                </Text>
              </Pressable>
            </View>

            {/* Selected video indicator */}
            <View className="flex-row items-center bg-pear-bg-card rounded-lg p-4">
              <View className="w-10 h-10 rounded-lg bg-pear-primary-muted items-center justify-center">
                <Feather name="film" color={colors.primary} size={20} />
              </View>
              <Text className="flex-1 text-label text-pear-text ml-3" numberOfLines={1}>
                Video selected
              </Text>
              <Pressable
                onPress={() => { setSelectedVideo(null); setFilePath(null); setFileSize(0); setThumbnailUri(null); }}
                className="w-8 h-8 items-center justify-center"
              >
                <Feather name="trash-2" color={colors.error} size={18} />
              </Pressable>
            </View>

            {/* Title input */}
            <TextInput
              placeholder="Video title"
              value={title}
              onChangeText={setTitle}
              placeholderTextColor={colors.textMuted}
              className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3.5 text-body text-pear-text"
            />

            {/* Category picker */}
            <View className="gap-2">
              <Text className="text-caption text-pear-text-muted">Category</Text>
              <View className="flex-row flex-wrap gap-2">
                {categoryOptions.map((cat) => (
                  <Pressable
                    key={cat}
                    onPress={() => setSelectedCategory(cat)}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: selectedCategory === cat ? colors.primary : colors.bgCard,
                    }}
                  >
                    <Text style={{
                      fontSize: 14,
                      fontWeight: '500',
                      color: selectedCategory === cat ? '#fff' : colors.text,
                    }}>
                      {cat}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Upload button or progress bar */}
            {uploading ? (
              <View className="gap-2">
                {/* Progress bar */}
                <View className="h-3 bg-pear-bg-input rounded-full overflow-hidden">
                  <View
                    className="h-full bg-pear-primary rounded-full"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </View>
                <View className="flex-row items-center justify-center gap-2">
                  <ActivityIndicator color={colors.primary} size="small" />
                  <Text className="text-pear-text-muted text-caption">
                    {isTranscoding ? (
                      `Transcoding audio... ${uploadProgress}%`
                    ) : (
                      <>
                        Uploading... {uploadProgress}%
                        {uploadSpeed > 0 && ` · ${formatSpeed(uploadSpeed)}`}
                        {uploadEta > 0 && ` · ${formatEta(uploadEta)} left`}
                      </>
                    )}
                  </Text>
                </View>
              </View>
            ) : (
              <Pressable
                onPress={handleUpload}
                disabled={!title.trim()}
                className={`flex-row items-center justify-center gap-2 bg-pear-primary rounded-lg py-3.5 ${!title.trim() ? 'opacity-50' : ''}`}
              >
                <Feather name="upload" color="white" size={18} />
                <Text className="text-white text-label">Upload Video</Text>
              </Pressable>
            )}
          </View>
        ) : (
          <Pressable
            onPress={pickVideo}
            className="flex-row items-center justify-center gap-3 bg-pear-bg-card border-2 border-dashed border-pear-border rounded-xl py-8 active:opacity-80"
          >
            <Feather name="upload" color={colors.textMuted} size={24} />
            <Text className="text-body text-pear-text-muted">Select a video to upload</Text>
          </Pressable>
        )}
      </View>

      {/* Videos List */}
      <View className="flex-1">
        <View className="px-5 py-4">
          <Text className="text-headline text-pear-text">Your Videos ({myVideos.length})</Text>
        </View>

        <FlatList
          data={myVideos}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingBottom: insets.bottom + 16,
            flexGrow: 1,
          }}
          ListEmptyComponent={
            <View className="flex-1 justify-center items-center py-16">
              <View className="w-16 h-16 rounded-full bg-pear-bg-card items-center justify-center mb-4">
                <Feather name="film" color={colors.textMuted} size={28} />
              </View>
              <Text className="text-body text-pear-text-muted text-center">
                No videos uploaded yet
              </Text>
            </View>
          }
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          renderItem={({ item }) => (
            <View className="flex-row bg-pear-bg-elevated rounded-xl overflow-hidden" style={{ minHeight: 72 }}>
              <View className="w-28 bg-pear-bg-card justify-center items-center">
                <Ionicons name="play" color={colors.text} size={16} />
              </View>
              <View className="flex-1 p-4 justify-center">
                <Text className="text-label text-pear-text" numberOfLines={1}>{item.title}</Text>
                <Text className="text-caption text-pear-text-muted mt-1">
                  {formatSize(item.size)} · {formatDate(item.uploadedAt)}
                </Text>
              </View>
              <Pressable
                onPress={() => handleDeleteVideo(item.id, item.title)}
                className="w-12 justify-center items-center active:opacity-60"
              >
                <Feather name="trash-2" color={colors.error} size={18} />
              </Pressable>
            </View>
          )}
        />
      </View>
    </View>
  )
}
