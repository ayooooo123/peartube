/**
 * Studio Tab - Upload and manage videos
 */
import { useState } from 'react'
import { View, Text, FlatList, Alert, Pressable, TextInput, ActivityIndicator, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Upload, Film, Trash2, Play } from 'lucide-react-native'
import * as ImagePicker from 'expo-image-picker'
import { useApp, colors } from '../_layout'

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

export default function StudioScreen() {
  const insets = useSafeAreaInsets()
  const { identity, videos, rpcCall, uploadVideo, pickVideoFile, loadVideos } = useApp()
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [title, setTitle] = useState('')
  const [selectedVideo, setSelectedVideo] = useState<string | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null) // Pear: actual file path
  const [fileSize, setFileSize] = useState<number>(0)
  const [mimeType, setMimeType] = useState<string>('video/mp4')

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
      setSelectedVideo(result.assets[0].uri)
      const filename = result.assets[0].uri.split('/').pop() || 'Untitled'
      setTitle(filename.replace(/\.[^/.]+$/, ''))
    }
  }

  const handleUpload = async () => {
    console.log('[Studio] handleUpload called:', {
      selectedVideo: !!selectedVideo,
      title: title.trim(),
      identity: !!identity,
      filePath: !!filePath
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
      Alert.alert('No identity', 'Please create an identity in Settings first')
      return
    }

    setUploading(true)
    setUploadProgress(0)

    try {
      if (isPear && filePath) {
        // Pear desktop: use file path based upload via uploadVideo from context
        console.log('[Studio] Uploading via Pear:', filePath)
        await uploadVideo(filePath, title.trim(), '', mimeType, (progress) => {
          setUploadProgress(progress)
        })
        // Reload videos after upload
        await loadVideos(identity.driveKey)
      } else {
        // Native: use regular RPC upload
        await rpcCall(Commands.UPLOAD_VIDEO, {
          uri: selectedVideo,
          title: title.trim(),
          description: '',
          driveKey: identity.driveKey,
        })
        await loadVideos(identity.driveKey)
      }

      setSelectedVideo(null)
      setFilePath(null)
      setTitle('')
      setFileSize(0)
      Alert.alert('Success', 'Video uploaded successfully!')
    } catch (err: any) {
      console.error('[Studio] Upload failed:', err)
      Alert.alert('Upload failed', err.message || 'Failed to upload video')
    } finally {
      setUploading(false)
      setUploadProgress(0)
    }
  }

  const myVideos = videos.filter((v) => v.channelKey === identity?.driveKey)

  return (
    <View className="flex-1 bg-pear-bg">
      {/* Header with safe area */}
      <View
        className="bg-pear-bg border-b border-pear-border"
        style={{ paddingTop: insets.top }}
      >
        <View className="px-5 py-4">
          <Text className="text-title text-pear-text">Studio</Text>
          <Text className="text-caption text-pear-text-muted mt-1">
            {identity ? `Channel: ${identity.name}` : 'No identity - create one in Settings'}
          </Text>
        </View>
      </View>

      {/* Upload Section */}
      <View className="px-5 py-5 border-b border-pear-border">
        {selectedVideo ? (
          <View className="gap-4">
            {/* Selected video indicator */}
            <View className="flex-row items-center bg-pear-bg-card rounded-lg p-4">
              <View className="w-10 h-10 rounded-lg bg-pear-primary-muted items-center justify-center">
                <Film color={colors.primary} size={20} />
              </View>
              <Text className="flex-1 text-label text-pear-text ml-3" numberOfLines={1}>
                Video selected
              </Text>
              <Pressable
                onPress={() => { setSelectedVideo(null); setFilePath(null); setFileSize(0); }}
                className="w-8 h-8 items-center justify-center"
              >
                <Trash2 color={colors.error} size={18} />
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
                    Uploading... {uploadProgress}%
                  </Text>
                </View>
              </View>
            ) : (
              <Pressable
                onPress={handleUpload}
                disabled={!title.trim()}
                className={`flex-row items-center justify-center gap-2 bg-pear-primary rounded-lg py-3.5 ${!title.trim() ? 'opacity-50' : ''}`}
              >
                <Upload color="white" size={18} />
                <Text className="text-white text-label">Upload Video</Text>
              </Pressable>
            )}
          </View>
        ) : (
          <Pressable
            onPress={pickVideo}
            className="flex-row items-center justify-center gap-3 bg-pear-bg-card border-2 border-dashed border-pear-border rounded-xl py-8 active:opacity-80"
          >
            <Upload color={colors.textMuted} size={24} />
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
                <Film color={colors.textMuted} size={28} />
              </View>
              <Text className="text-body text-pear-text-muted text-center">
                No videos uploaded yet
              </Text>
            </View>
          }
          ItemSeparatorComponent={() => <View className="h-3" />}
          renderItem={({ item }) => (
            <View className="flex-row bg-pear-bg-elevated rounded-xl overflow-hidden" style={{ minHeight: 72 }}>
              <View className="w-28 bg-pear-bg-card justify-center items-center">
                <Play color={colors.text} size={16} fill={colors.text} />
              </View>
              <View className="flex-1 p-4 justify-center">
                <Text className="text-label text-pear-text" numberOfLines={1}>{item.title}</Text>
                <Text className="text-caption text-pear-text-muted mt-1">
                  {formatSize(item.size)} · {formatDate(item.uploadedAt)}
                </Text>
              </View>
            </View>
          )}
        />
      </View>
    </View>
  )
}
