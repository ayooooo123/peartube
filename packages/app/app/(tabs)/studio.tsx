/**
 * Studio Tab - Upload and manage videos
 */
import { useRef, useState, useCallback, useEffect } from 'react'
import { View, Text, FlatList, Alert, Pressable, TextInput, ActivityIndicator, Platform, Image, AppState, InteractionManager } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather, Ionicons } from '@expo/vector-icons'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import * as VideoThumbnails from 'expo-video-thumbnails'
import { useApp, colors } from '../_layout'
import { CastHeaderButton } from '@/components/cast'
import { useVideoPlayerActions } from '@/lib/VideoPlayerContext'
import { VideoEditModal } from '@/components/VideoEditModal'
import { formatBytes } from '@/lib/formatters'
import { useTabBarMetrics } from '@/lib/tabBarHeight'
import { Chip, EmptyState } from '@/components/primitives'
import { fonts } from '@/lib/typography'
import * as haptics from '@/lib/haptics'
import { makeVideoUrlCacheKey, setCachedVideoUrl } from '@/lib/video-url-cache'
import type { Video } from '@peartube/core'
import { DeveloperModeGate } from '@/lib/developer-mode'

// Detect Pear desktop (must match index.web.tsx detection)
const isPear = Platform.OS === 'web' && typeof window !== 'undefined' && (!!(window as any).Pear || !!(window as any).bridge)

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

function normalizeFsModule(mod: any): any {
  return mod?.default ?? mod
}

// expo-file-system: prefer the legacy API (stable copyAsync/deleteAsync/cacheDirectory),
// fall back to the new module if legacy is unavailable.
async function getFileSystem(): Promise<any | null> {
  if (Platform.OS === 'web') return null
  try {
    return normalizeFsModule(await import('expo-file-system/legacy'))
  } catch {
    try {
      return normalizeFsModule(await import('expo-file-system'))
    } catch {
      return null
    }
  }
}

// Copy an Android SAF content:// (or file://) URI into the app cache and return a
// real file:// path. The P2P backend streams the upload off a filesystem path
// (bare-fs can't read content:// URIs), so we must materialize a local copy. We do
// this ourselves — with visible UI feedback — instead of letting the document
// picker copy inline (copyToCacheDirectory), which blocks with no feedback and is
// unreliable/slow for large (1GB+) files.
async function copyPickedVideoToCache(srcUri: string, name?: string): Promise<string> {
  const fs = await getFileSystem()
  const cacheDir: string | undefined = fs?.cacheDirectory || fs?.Paths?.cache?.uri
  if (!fs || typeof fs.copyAsync !== 'function' || !cacheDir) {
    throw new Error('File system unavailable')
  }
  const rawExt = (name?.split('.').pop() || srcUri.split('.').pop() || 'mp4')
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5) || 'mp4'
  const dest = `${cacheDir.replace(/\/?$/, '/')}peartube-upload-${Date.now()}.${ext}`
  await fs.copyAsync({ from: srcUri, to: dest })
  return dest
}

async function deleteCachedFile(uri: string | null | undefined): Promise<void> {
  if (!uri) return
  try {
    const fs = await getFileSystem()
    if (fs && typeof fs.deleteAsync === 'function') {
      await fs.deleteAsync(uri, { idempotent: true })
    }
  } catch {
    // best-effort cleanup
  }
}

function StudioScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { identity, videos, rpc, uploadVideo, pickVideoFile, pickImageFile, loadVideos, removeVideo } = useApp()
  const { pauseVideo, closeVideo, suppressForegroundRestoreOnce, suppressForegroundRestoreFor, clearLastClosedVideo, loadAndPlayVideo } = useVideoPlayerActions()
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
  const [thumbnailFilePath, setThumbnailFilePath] = useState<string | null>(null) // File path/URI for uploading thumbnail
  const [videoDuration, setVideoDuration] = useState<number | null>(null)
  const [thumbnailGenerating, setThumbnailGenerating] = useState(false)
  const [thumbnailError, setThumbnailError] = useState<string | null>(null)
  const thumbnailGenIdRef = useRef(0)
  const [pickingVideo, setPickingVideo] = useState(false)
  const pickingVideoRef = useRef(false)
  const [preparingVideo, setPreparingVideo] = useState(false) // Android: copying picked file into cache
  const tempVideoUriRef = useRef<string | null>(null) // app-cache copy we created; deleted after upload/reset
  const [editingVideo, setEditingVideo] = useState<any>(null)
  // Per-publication source-offload assessments. Eligibility is only a prompt to
  // request explicit confirmation; the backend rechecks and consumes the nonce.
  const [offloadInfo, setOffloadInfo] = useState<Record<string, {
    eligible: boolean
    byteLength: number
    publicationId?: string
    assessmentId?: string
    evidenceDigest?: string
    confirmationNonce?: string
    policyVersion?: number
    limitations?: string[]
    offloaded?: boolean
    busy?: boolean
  }>>({})
  const assessedOffloadRef = useRef<Set<string>>(new Set())
  const tabBarMetrics = useTabBarMetrics()
  const bottomPadding = Math.max(tabBarMetrics.height + 16, insets.bottom + 16)

  // Delete the temporary cache copy we made of the picked video (Android), if any.
  const cleanupTempVideo = useCallback(async () => {
    const uri = tempVideoUriRef.current
    tempVideoUriRef.current = null
    await deleteCachedFile(uri)
  }, [])

  const uploadThumbnailForVideo = useCallback(async (videoId: string, thumbPath: string) => {
    if (!rpc || !videoId || !thumbPath) return false

    const result = await rpc.setVideoThumbnailFromFile({
      videoId,
      filePath: thumbPath,
    })

    if (!result?.success) {
      throw new Error(result?.error || 'setVideoThumbnailFromFile failed')
    }

    return true
  }, [rpc])

  // Generate thumbnail from video at 10%
  const generateThumbnail = useCallback(async (videoUri: string, durationMs?: number) => {
    if (isPear) return // Desktop handles thumbnails server-side
    try {
      const genId = ++thumbnailGenIdRef.current
      setThumbnailGenerating(true)
      setThumbnailError(null)
      const primaryTime = durationMs ? Math.floor(durationMs * 0.1) : 1000
      const times = Array.from(new Set([primaryTime, 1000, 2000].filter((t) => t >= 0)))

      for (const timeMs of times) {
        try {
          console.log('[Studio] Generating thumbnail at', timeMs, 'ms')
          const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
            time: timeMs,
            quality: 0.7,
          })
          console.log('[Studio] Thumbnail generated:', uri)
          // Ignore stale generations (user picked another video)
          if (thumbnailGenIdRef.current !== genId) return null
          setThumbnailUri(uri)
          setThumbnailFilePath(uri)
          return uri
        } catch (err) {
          console.log('[Studio] Thumbnail attempt failed at', timeMs, 'ms:', err)
        }
      }

      if (thumbnailGenIdRef.current === genId) {
        setThumbnailError('Could not generate thumbnail. Please pick an image.')
      }

      return null
    } catch (err) {
      console.log('[Studio] Thumbnail generation failed:', err)
      setThumbnailError('Could not generate thumbnail. Please pick an image.')
      return null
    } finally {
      setThumbnailGenerating(false)
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
          if ('dataUrl' in result && typeof result.dataUrl === 'string') {
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
      setThumbnailFilePath(result.assets[0].uri)
      setThumbnailError(null)
    }
  }, [pickImageFile])

  const pickVideo = async () => {
    if (pickingVideoRef.current) return
    if (AppState.currentState !== 'active') return

    pickingVideoRef.current = true
    setPickingVideo(true)
    // Opening a system picker backgrounds the app. Our VideoPlayerContext tries to
    // auto-restore the last closed video on foreground, which can cause surprise playback
    // and a black overlay. Suppress that once for picker flows.
    suppressForegroundRestoreOnce()
    suppressForegroundRestoreFor(8000)
    pauseVideo()
    closeVideo()
    clearLastClosedVideo()

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

    try {
      // Android: prefer DocumentPicker to avoid Photo Picker URI permission issues.
      if (Platform.OS === 'android') {
        // copyToCacheDirectory:false → the picker returns immediately with a
        // content:// URI instead of blocking (with no UI feedback) while it copies
        // the whole file. For 1GB+ videos the inline copy is what made the screen
        // hang/"never load". We copy into cache ourselves below, with feedback.
        const docResult = await DocumentPicker.getDocumentAsync({
          type: 'video/*',
          copyToCacheDirectory: false,
          multiple: false,
        })

        if (docResult.canceled) return
        const asset = docResult.assets?.[0]
        if (!asset?.uri) return

        // Reset prior selection/preview state and drop any earlier temp copy.
        setThumbnailUri(null)
        setThumbnailFilePath(null)
        setThumbnailError(null)
        void cleanupTempVideo()

        const filename = asset.name || asset.uri.split('/').pop() || 'Untitled'
        setTitle(filename.replace(/\.[^/.]+$/, ''))
        if (typeof asset.size === 'number') setFileSize(asset.size)
        if (typeof asset.mimeType === 'string') setMimeType(asset.mimeType)

        // Materialize a real file:// path the backend can stream from. Show a
        // "Preparing…" state so the user isn't staring at a frozen/black screen.
        setPreparingVideo(true)
        try {
          const localUri = await copyPickedVideoToCache(asset.uri, asset.name || undefined)
          tempVideoUriRef.current = localUri
          setSelectedVideo(localUri)

          // Kick off thumbnail generation (non-blocking) from the cached file:// URI.
          InteractionManager.runAfterInteractions(() => {
            void generateThumbnail(localUri).catch((err) => {
              console.log('[Studio] Background thumbnail generation failed:', err)
            })
          })
        } catch (err: any) {
          console.error('[Studio] Failed to prepare video:', err)
          Alert.alert('Could not prepare video', err?.message || 'Failed to read the selected video. Please try again.')
        } finally {
          setPreparingVideo(false)
        }

        return
      }

      // iOS: use expo-image-picker
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync()
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Please grant permission to access your videos')
        return
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        allowsEditing: false,
        videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
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

        // Generate thumbnail at 10% into video, but don't block UI.
        setThumbnailUri(null)
        setThumbnailFilePath(null)
        setThumbnailError(null)
        InteractionManager.runAfterInteractions(() => {
          void generateThumbnail(asset.uri, asset.duration ?? undefined).catch((err) => {
            console.log('[Studio] Background thumbnail generation failed:', err)
          })
        })
      }
    } catch (err: any) {
      console.error('[Studio] pickVideo error:', err)
      Alert.alert('Error', err?.message || 'Failed to open video picker')
    } finally {
      pickingVideoRef.current = false
      setPickingVideo(false)
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
      console.error('[Studio] No identity! Please create one in Profile first')
      Alert.alert('No channel yet', 'Create your channel from the Profile screen first.')
      return
    }

    if (!identity.driveKey) {
      console.error('[Studio] Identity missing driveKey')
      Alert.alert('Channel error', 'Your channel is missing its key. Please recreate it from the Profile screen.')
      return
    }

    const driveKey = identity.driveKey

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
            const uploaded = await uploadThumbnailForVideo(videoId, thumbnailFilePath)
            console.log('[Studio] Thumbnail upload result:', uploaded)
          } catch (thumbErr) {
            console.error('[Studio] Failed to upload thumbnail:', thumbErr)
            // Don't fail the whole upload if thumbnail fails
          }
        }

        // Reload videos after upload
        await loadVideos(driveKey)
      } else if (rpc) {
        // Native: use AppContext uploadVideo so we get streaming progress events.
        // Prefer the RN-generated thumbnail when available.
        // Keep backend (bare-ffmpeg) thumbnail generation available as a fallback
        // on iOS only. (Android backend thumbnail generation has been crash-prone.)
        const skipThumbnail = Platform.OS === 'android'
          ? true
          : (thumbnailGenerating || !!thumbnailFilePath)

        const video = await uploadVideo(
          selectedVideo,
          title.trim(),
          '',
          mimeType,
          selectedCategory,
          (progress, speed, eta, transcoding) => {
            setUploadProgress(progress)
            if (speed !== undefined) setUploadSpeed(speed)
            if (eta !== undefined) setUploadEta(eta)
            setIsTranscoding(!!transcoding)
          },
          skipThumbnail
        )

        videoId = video?.id
        console.log('[Studio] Upload complete, videoId:', videoId, 'skippedThumbnail:', skipThumbnail)

        // If we have a thumbnail file/URI, upload it (no base64)
        if (thumbnailFilePath && videoId) {
          console.log('[Studio] Uploading thumbnail from file:', thumbnailFilePath)
          try {
            const uploaded = await uploadThumbnailForVideo(videoId, thumbnailFilePath)
            console.log('[Studio] Thumbnail upload result:', uploaded)
          } catch (thumbErr: any) {
            console.error('[Studio] Failed to upload thumbnail:', thumbErr?.message || thumbErr)
            // Don't fail the whole upload if thumbnail fails
          }
        } else {
          console.log('[Studio] No thumbnail to upload, thumbnailFilePath:', thumbnailFilePath, 'videoId:', videoId)
        }

      }

      setSelectedVideo(null)
      setFilePath(null)
      setTitle('')
      setFileSize(0)
      setThumbnailUri(null)
      setThumbnailFilePath(null)
      setVideoDuration(null)
      setSelectedCategory('Other')
      setThumbnailError(null)
      void cleanupTempVideo()
      haptics.success()
      Alert.alert('Published!', 'Your video is live on your channel.')
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

  const listHeaderComponent = (
    <View>
        {/* Upload Section */}
        <View className="py-5 border-b border-pear-border">
          {selectedVideo ? (
            <View className="gap-4">
              {/* Thumbnail preview */}
              <View className="rounded-xl overflow-hidden bg-pear-bg-card">
                <View style={{ aspectRatio: 16 / 9 }}>
                  {thumbnailUri ? (
                    <View style={{ width: '100%', height: '100%' }}>
                      <Image
                        source={{ uri: thumbnailUri }}
                        style={{ width: '100%', height: '100%' }}
                        resizeMode="cover"
                      />
                      {thumbnailGenerating ? (
                        <View
                          style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            top: 0,
                            bottom: 0,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: 'rgba(0,0,0,0.25)',
                          }}
                        >
                          <ActivityIndicator color={colors.text} />
                        </View>
                      ) : null}
                    </View>
                  ) : (
                    <View className="flex-1 items-center justify-center bg-pear-bg-elevated">
                      <Feather name="film" color={colors.textMuted} size={48} />
                      <Text className="text-caption text-pear-text-muted mt-2">
                        {isPear
                          ? 'Click below to add thumbnail'
                          : (thumbnailGenerating
                            ? 'Generating thumbnail...'
                            : (thumbnailError ? thumbnailError : 'Thumbnail not available'))}
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
                  onPress={() => { setSelectedVideo(null); setFilePath(null); setFileSize(0); setThumbnailUri(null); setThumbnailFilePath(null); setVideoDuration(null); setThumbnailError(null); void cleanupTempVideo(); }}
                  className="w-8 h-8 items-center justify-center"
                >
                  <Feather name="trash-2" color={colors.error} size={18} />
                </Pressable>
              </View>

              {!isPear && thumbnailError ? (
                <View className="bg-pear-bg-elevated border border-pear-border rounded-lg p-4">
                  <Text className="text-caption text-pear-text-muted">
                    Thumbnail generation failed. Tap Add Thumbnail to pick an image.
                  </Text>
                </View>
              ) : null}

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
                    <Chip
                      key={cat}
                      label={cat}
                      selected={selectedCategory === cat}
                      onPress={() => setSelectedCategory(cat)}
                    />
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
                        `Optimizing for streaming… ${uploadProgress}%`
                      ) : (
                        <>
                          Adding to your channel… {uploadProgress}%
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
                  disabled={
                    !title.trim() ||
                    (!isPear && (thumbnailGenerating || !thumbnailFilePath))
                  }
                  className={`flex-row items-center justify-center gap-2 bg-pear-primary rounded-lg py-3.5 ${(!title.trim() || (!isPear && (thumbnailGenerating || !thumbnailFilePath))) ? 'opacity-50' : ''}`}
                >
                  <Feather name="upload" color={colors.onPrimary} size={18} />
                  <Text className="text-label" style={{ color: colors.onPrimary }}>
                    {!isPear && thumbnailGenerating
                      ? 'Preparing thumbnail…'
                      : (!isPear && !thumbnailFilePath)
                        ? 'Add a thumbnail to publish'
                        : 'Publish'}
                  </Text>
                </Pressable>
              )}
            </View>
          ) : (
            <Pressable
              onPress={pickVideo}
              disabled={pickingVideo || preparingVideo}
              className="flex-row items-center justify-center gap-3 bg-pear-bg-card border-2 border-dashed border-pear-border rounded-xl py-8 active:opacity-80"
            >
              {preparingVideo ? (
                <ActivityIndicator color={colors.textMuted} size="small" />
              ) : (
                <Feather name="upload" color={colors.textMuted} size={24} />
              )}
              <Text className="text-body text-pear-text-muted">
                {preparingVideo ? 'Preparing video…' : (pickingVideo ? 'Opening picker…' : 'Choose a video to share')}
              </Text>
            </Pressable>
          )}
        </View>

        {/* Videos List title */}
        <View className="py-4">
          <Text style={{ color: colors.text, fontSize: 18, fontFamily: fonts.heading }}>
            Published ({myVideos.length})
          </Text>
        </View>
    </View>
  )

  // Quietly assess immutable publication sources. The destructive operation
  // remains unavailable until the backend issues a fresh, evidence-bound nonce.
  useEffect(() => {
    const assess = rpc?.assessSourceOffload
    if (typeof assess !== 'function' || !identity?.driveKey) return
    const mine = videos.filter((v) => v.channelKey === identity.driveKey)
    let cancelled = false
    ;(async () => {
      for (const v of mine) {
        if (cancelled) return
        const publicationId = v.immutablePublication?.publicationId || v.publicationId
        if (!publicationId || assessedOffloadRef.current.has(publicationId)) continue
        assessedOffloadRef.current.add(publicationId)
        try {
          const res = await assess({ publicationId })
          if (cancelled) return
          setOffloadInfo((prev) => ({
            ...prev,
            [v.id]: {
              eligible: res?.success === true && res?.eligible === true,
              byteLength: Number(res?.byteLength) || 0,
              publicationId: res?.publicationId,
              assessmentId: res?.assessmentId,
              evidenceDigest: res?.evidenceDigest,
              confirmationNonce: res?.confirmationNonce,
              policyVersion: res?.policyVersion,
              limitations: Array.isArray(res?.limitations) ? res.limitations : [],
            },
          }))
        } catch {
          assessedOffloadRef.current.delete(publicationId)
        }
      }
    })()
    return () => { cancelled = true }
  }, [videos, identity?.driveKey, rpc])

  const handleOffloadVideo = async (item: Video) => {
    const info = offloadInfo[item.id]
    if (!info?.publicationId || typeof rpc?.assessSourceOffload !== 'function') return
    setOffloadInfo((prev) => ({ ...prev, [item.id]: { ...prev[item.id], busy: true } }))

    try {
      const fresh = await rpc?.assessSourceOffload({ publicationId: info.publicationId })
      if (!fresh?.success || !fresh.eligible || !fresh.publicationId || !fresh.assessmentId ||
          !fresh.evidenceDigest || !fresh.confirmationNonce || !fresh.policyVersion) {
        assessedOffloadRef.current.delete(info.publicationId)
        setOffloadInfo((prev) => ({ ...prev, [item.id]: { ...prev[item.id], eligible: false, busy: false } }))
        const m = `Source offload is no longer safe. ${fresh?.reason || 'Current archive evidence is insufficient.'}`
        if (Platform.OS === 'web') window.alert(m)
        else Alert.alert('Source offload stopped', m)
        return
      }

      const freshInfo = {
        eligible: true,
        byteLength: Number(fresh.byteLength) || 0,
        publicationId: fresh.publicationId,
        assessmentId: fresh.assessmentId,
        evidenceDigest: fresh.evidenceDigest,
        confirmationNonce: fresh.confirmationNonce,
        policyVersion: fresh.policyVersion,
        limitations: Array.isArray(fresh.limitations) ? fresh.limitations : [],
        busy: true,
      }
      setOffloadInfo((prev) => ({ ...prev, [item.id]: freshInfo }))
      const freed = freshInfo.byteLength ? ` (${formatBytes(freshInfo.byteLength)})` : ''
      const limitations = freshInfo.limitations.length
        ? `\n\nEvidence limitations:\n${freshInfo.limitations.map((value: string) => `• ${value}`).join('\n')}`
        : ''
      const confirmed = await new Promise<boolean>((resolve) => {
        const msg = `Delete this device's source bytes for "${item.title}"${freed}?\n\nPublication: ${fresh.publicationId}\n\nThis cannot guarantee the media remains recoverable. Other copies may disappear after confirmation.${limitations}\n\nContinue only if you accept permanent loss risk.`
        if (Platform.OS === 'web') {
          resolve(window.confirm(msg))
        } else {
          Alert.alert('Confirm source offload', msg, [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'I understand — delete source', style: 'destructive', onPress: () => resolve(true) },
          ])
        }
      })
      if (!confirmed) {
        setOffloadInfo((prev) => ({ ...prev, [item.id]: { ...prev[item.id], busy: false } }))
        return
      }

      const res = await rpc?.confirmSourceOffload({
        publicationId: fresh.publicationId,
        assessmentId: fresh.assessmentId,
        evidenceDigest: fresh.evidenceDigest,
        confirmationNonce: fresh.confirmationNonce,
        policyVersion: fresh.policyVersion,
        confirmIrrecoverableRisk: true,
      })
      if (res?.success) {
        setOffloadInfo((prev) => ({ ...prev, [item.id]: { eligible: false, byteLength: freshInfo.byteLength, publicationId: fresh.publicationId, offloaded: true, busy: false } }))
      } else {
        assessedOffloadRef.current.delete(fresh.publicationId)
        setOffloadInfo((prev) => ({ ...prev, [item.id]: { ...prev[item.id], eligible: false, busy: false } }))
        const m = `Couldn't delete the local source. ${res?.reason || 'The evidence or policy changed; reassess before trying again.'}`
        if (Platform.OS === 'web') window.alert(m)
        else Alert.alert('Source offload stopped', m)
      }
    } catch (err: unknown) {
      assessedOffloadRef.current.delete(info.publicationId)
      setOffloadInfo((prev) => ({ ...prev, [item.id]: { ...prev[item.id], eligible: false, busy: false } }))
      const m = err instanceof Error ? err.message : 'Failed to delete local source'
      if (Platform.OS === 'web') window.alert(m)
      else Alert.alert('Source offload stopped', m)
    }
  }

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

    const removedVideo = videos.find(v => v.id === videoId)
    removeVideo(videoId)

    try {
      const result = await rpc?.deleteVideo({ videoId })
      if (result?.success) {
        if (identity?.driveKey) {
          loadVideos(identity.driveKey, { allowEmptyResult: true }).catch(() => {})
        }
      } else {
        const errorMsg = result?.error || 'Failed to delete video'
        if (identity?.driveKey) {
          loadVideos(identity.driveKey).catch(() => {})
        }
        if (Platform.OS === 'web') {
          window.alert(`Error: ${errorMsg}`)
        } else {
          Alert.alert('Error', errorMsg)
        }
      }
    } catch (err: any) {
      console.error('[Studio] Delete failed:', err)
      if (identity?.driveKey) {
        loadVideos(identity.driveKey).catch(() => {})
      }
      const errorMsg = err.message || 'Failed to delete video'
      if (Platform.OS === 'web') {
        window.alert(`Error: ${errorMsg}`)
      } else {
        Alert.alert('Error', errorMsg)
      }
    }
  }

  const playPublishedVideo = useCallback(async (item: any) => {
    if (!rpc) return
    const channelKey = item?.channelKey || identity?.driveKey
    if (!channelKey || !item?.id) return

    const videoRef = (item.path && typeof item.path === 'string' && item.path.startsWith('/'))
      ? item.path
      : item.id
    const cacheKey = makeVideoUrlCacheKey(
      channelKey,
      videoRef,
      item.blobId || undefined,
      item.blobsCoreKey || undefined,
    )
    const playbackRequest = {
      channelKey,
      videoId: videoRef,
      publicBeeKey: item.publicBeeKey || undefined,
      blobId: item.blobId || undefined,
      blobsCoreKey: item.blobsCoreKey || undefined,
      mimeType: item.mimeType || undefined,
    }
    const video = { ...item, channelKey }

    try {
      const result = await rpc.preparePlayback(playbackRequest)
      if (result?.url) {
        if (cacheKey) setCachedVideoUrl(cacheKey, result.url)
        loadAndPlayVideo(video, result.url)
      } else {
        Alert.alert('Playback unavailable', 'Could not prepare this video for playback yet.')
      }
    } catch (err: any) {
      console.error('[Studio] Failed to play published video:', err?.message || err)
      Alert.alert('Playback unavailable', err?.message || 'Could not prepare this video for playback yet.')
    }
  }, [identity?.driveKey, loadAndPlayVideo, rpc])

  return (
    <View className="flex-1 bg-pear-bg">
      {/* Header with safe area */}
      <View
        className="bg-pear-bg border-b border-pear-border"
        style={{ paddingTop: insets.top }}
      >
        <View className="px-5 py-4">
          <View className="flex-row items-center justify-between">
            <Text style={{ color: colors.text, fontSize: 24, fontFamily: fonts.heading }}>Studio</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <CastHeaderButton size={18} />
              <Pressable onPress={() => router.push('/search')} className="p-2">
                <Feather name="search" color={colors.text} size={18} />
              </Pressable>
            </View>
          </View>
          {identity ? (
            <Text className="text-caption text-pear-text-muted mt-1">{identity.name}</Text>
          ) : (
            <Pressable onPress={() => router.push('/profile')}>
              <Text className="text-caption mt-1" style={{ color: colors.primary }}>
                Set up your channel to start publishing →
              </Text>
            </Pressable>
          )}
        </View>
      </View>

      <FlatList
        data={myVideos}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={listHeaderComponent}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: bottomPadding,
        }}
        ListEmptyComponent={
          <EmptyState
            icon="film"
            title="Nothing published yet"
            body="Pick a video above — it streams directly from your devices, no servers involved."
          />
        }
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        renderItem={({ item }) => (
          <View className="flex-row bg-pear-bg-elevated rounded-xl overflow-hidden" style={{ minHeight: 72 }}>
            <Pressable
              onPress={() => playPublishedVideo(item)}
              className="flex-1 flex-row active:opacity-80"
              accessibilityRole="button"
              accessibilityLabel={`Play ${item.title}`}
            >
              <View className="w-28 bg-pear-bg-card justify-center items-center">
                <Ionicons name="play" color={colors.text} size={16} />
              </View>
              <View className="flex-1 p-4 justify-center">
                <Text className="text-label text-pear-text" numberOfLines={1}>{item.title}</Text>
                <Text className="text-caption text-pear-text-muted mt-1">
                  {formatBytes(item.size)} · {formatDate(item.uploadedAt)}
                </Text>
              </View>
            </Pressable>
            <Pressable
              onPress={() => setEditingVideo(item)}
              style={({ pressed }) => ({
                width: 44,
                justifyContent: 'center',
                alignItems: 'center',
                opacity: pressed ? 0.6 : 1,
                transform: [{ scale: pressed ? 0.85 : 1 }],
              })}
            >
              <Feather name="edit-2" color={colors.text} size={18} />
            </Pressable>
            {offloadInfo[item.id]?.offloaded ? (
              <View className="w-12 justify-center items-center">
                <Feather name="cloud" color={colors.text} size={16} />
              </View>
            ) : offloadInfo[item.id]?.eligible ? (
              <Pressable
                onPress={() => handleOffloadVideo(item)}
                disabled={offloadInfo[item.id]?.busy}
                className="w-12 justify-center items-center active:opacity-60"
                accessibilityLabel="Free up local space"
              >
                {offloadInfo[item.id]?.busy
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Feather name="download-cloud" color={colors.primary} size={18} />}
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => handleDeleteVideo(item.id, item.title)}
              className="w-12 justify-center items-center active:opacity-60"
            >
              <Feather name="trash-2" color={colors.error} size={18} />
            </Pressable>
          </View>
        )}
      />

      <VideoEditModal
        visible={!!editingVideo}
        video={editingVideo}
        channelKey={identity?.driveKey || ''}
        onClose={() => setEditingVideo(null)}
        onSaved={() => {
          setEditingVideo(null)
          if (identity?.driveKey) {
            loadVideos(identity.driveKey).catch(() => {})
          }
        }}
      />
    </View>
  )
}

export default function DeveloperStudioScreen() {
  return <DeveloperModeGate><StudioScreen /></DeveloperModeGate>
}
