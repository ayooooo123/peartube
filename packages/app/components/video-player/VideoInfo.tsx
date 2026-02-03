/**
 * VideoInfo - Video title and metadata display
 *
 * Displays video title, upload time, and size.
 * Uses the VideoMetaContext for video metadata.
 */

import { memo } from 'react'
import { View, Text, Pressable } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { colors } from '@/lib/colors'
import { styles } from './styles'
import { formatTimeAgo, formatSize } from './formatters'

interface VideoInfoProps {
  title: string
  uploadedAt?: number
  size?: number
  isCasting?: boolean
  castDeviceName?: string
  onCastDisconnect?: () => void
}

export const VideoInfo = memo(function VideoInfo({
  title,
  uploadedAt,
  size,
  isCasting,
  castDeviceName,
  onCastDisconnect,
}: VideoInfoProps) {
  return (
    <View style={styles.videoInfo}>
      <Text style={styles.videoTitle}>{title}</Text>

      {isCasting && (
        <View style={styles.castBanner}>
          <Feather name="cast" color={colors.primary} size={14} />
          <Text style={styles.castBannerText}>Casting to {castDeviceName}</Text>
          <Pressable onPress={onCastDisconnect} style={styles.castBannerAction}>
            <Text style={styles.castBannerActionText}>Disconnect</Text>
          </Pressable>
        </View>
      )}

      <Text style={styles.videoMeta}>
        {formatTimeAgo(uploadedAt)} · {formatSize(size)}
      </Text>
    </View>
  )
})
