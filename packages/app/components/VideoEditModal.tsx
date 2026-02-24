import { useEffect, useState } from 'react'
import {
  Modal,
  View,
  Text,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Pressable,
  type PressableProps,
  type ViewStyle,
} from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import { Feather } from '@expo/vector-icons'
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { useApp } from '@/lib/AppContext'
import { colors } from '@/lib/colors'

const CATEGORIES = ['Music', 'Gaming', 'Tech', 'Education', 'Entertainment', 'Vlog', 'Other']

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

interface AnimatedFeedbackPressableProps extends PressableProps {
  style?: ViewStyle | ViewStyle[]
}

function AnimatedFeedbackPressable({ children, style, onPressIn, onPressOut, ...props }: AnimatedFeedbackPressableProps) {
  const scale = useSharedValue(1)
  const opacity = useSharedValue(1)

  const handlePressIn: PressableProps['onPressIn'] = (event) => {
    scale.value = withSpring(0.9, { damping: 15, stiffness: 400 })
    opacity.value = withTiming(0.7, { duration: 100 })
    onPressIn?.(event)
  }

  const handlePressOut: PressableProps['onPressOut'] = (event) => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 })
    opacity.value = withTiming(1, { duration: 100 })
    onPressOut?.(event)
  }

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }))

  return (
    <AnimatedPressable
      {...props}
      style={[style, animatedStyle]}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
    >
      {children}
    </AnimatedPressable>
  )
}

interface VideoEditModalProps {
  visible: boolean
  video: any
  channelKey: string
  onClose: () => void
  onSaved: () => void
}

export function VideoEditModal({ visible, video, channelKey, onClose, onSaved }: VideoEditModalProps) {
  const { rpc } = useApp()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (video) {
      setTitle(video.title || '')
      setDescription(video.description || '')
      setCategory(video.category || '')
      setError(null)
    }
  }, [video])

  const handleChangeThumbnail = async () => {
    if (!video?.id) {
      setError('Missing video id')
      return
    }

    try {
      setError(null)
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        base64: true,
      })

      if (result.canceled || !result.assets?.[0]) return

      const asset = result.assets[0]
      if (!asset.base64) {
        setError('Unable to read image data')
        return
      }

      const thumbRes = await (rpc as any).setVideoThumbnail({
        videoId: video.id,
        imageData: asset.base64,
        mimeType: asset.mimeType || 'image/jpeg',
      })

      if (!thumbRes?.success) {
        setError(thumbRes?.error || 'Failed to update thumbnail')
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to update thumbnail')
    }
  }

  const handleSave = async () => {
    if (!rpc || !video?.id || !channelKey) {
      setError('Missing required data to save changes')
      return
    }

    setSaving(true)
    setError(null)

    try {
      const result = await (rpc as any).updateVideoMetadata({
        channelKey,
        videoId: video.id,
        title,
        description,
        category,
      })

      if (!result?.success) {
        setError(result?.error || 'Failed to save video changes')
        return
      }

      onSaved()
    } catch (err: any) {
      setError(err?.message || 'Failed to save video changes')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.7)' }}>
        <View className="bg-pear-bg rounded-t-3xl overflow-hidden" style={{ maxHeight: '85%' }}>
          <View className="flex-row items-center justify-between px-5 py-4 border-b border-pear-border">
            <Text className="text-title text-pear-text">Edit Video</Text>
            <AnimatedFeedbackPressable onPress={onClose} className="p-1">
              <Feather name="x" size={24} color={colors.text} />
            </AnimatedFeedbackPressable>
          </View>

          <ScrollView className="max-h-[560px]" contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 16, gap: 14 }}>
            <View>
              <Text className="text-label text-pear-text mb-1.5">Title</Text>
              <TextInput
                className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3.5 text-body text-pear-text"
                placeholder="Video title"
                placeholderTextColor={colors.textMuted}
                value={title}
                onChangeText={setTitle}
              />
            </View>

            <View>
              <Text className="text-label text-pear-text mb-1.5">Description</Text>
              <TextInput
                className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3.5 text-body text-pear-text"
                placeholder="Describe your video"
                placeholderTextColor={colors.textMuted}
                value={description}
                onChangeText={setDescription}
                multiline
                numberOfLines={4}
                style={{ textAlignVertical: 'top' }}
              />
            </View>

            <View>
              <Text className="text-label text-pear-text mb-1.5">Category</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View className="flex-row gap-2 pr-1">
                  {CATEGORIES.map((item) => {
                    const selected = category === item
                    return (
                      <AnimatedFeedbackPressable
                        key={item}
                        onPress={() => setCategory(item)}
                        className={`px-4 py-2 rounded-full ${selected ? 'bg-pear-primary' : 'bg-pear-bg-card'}`}
                      >
                        <Text className={`text-label ${selected ? 'text-white' : 'text-pear-text'}`}>{item}</Text>
                      </AnimatedFeedbackPressable>
                    )
                  })}
                </View>
              </ScrollView>
            </View>

            <View>
              <Text className="text-label text-pear-text mb-1.5">Thumbnail</Text>
              <AnimatedFeedbackPressable
                onPress={handleChangeThumbnail}
                className="flex-row items-center justify-center gap-2 bg-pear-bg-card border border-pear-border rounded-lg py-3.5"
              >
                <Feather name="image" size={18} color={colors.text} />
                <Text className="text-label text-pear-text">Change Thumbnail</Text>
              </AnimatedFeedbackPressable>
            </View>

            {error ? <Text className="text-caption text-pear-error">{error}</Text> : null}
          </ScrollView>

          <View className="flex-row gap-3 px-5 py-4 border-t border-pear-border">
            <AnimatedFeedbackPressable
              onPress={onClose}
              disabled={saving}
              className={`flex-1 items-center justify-center rounded-lg py-3.5 bg-pear-bg-card border border-pear-border ${saving ? 'opacity-50' : ''}`}
            >
              <Text className="text-label text-pear-text">Cancel</Text>
            </AnimatedFeedbackPressable>

            <AnimatedFeedbackPressable
              onPress={handleSave}
              disabled={saving}
              className={`flex-1 items-center justify-center rounded-lg py-3.5 bg-pear-primary ${saving ? 'opacity-50' : ''}`}
            >
              {saving ? <ActivityIndicator size="small" color="#fff" /> : <Text className="text-label text-white">Save</Text>}
            </AnimatedFeedbackPressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

export default VideoEditModal
