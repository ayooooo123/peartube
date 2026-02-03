/**
 * ChannelInfo - Channel avatar and name display
 *
 * Displays channel information with avatar, name, and subscribe button.
 * Memoized since channel info rarely changes during video playback.
 */

import { memo } from 'react'
import { View, Text, Pressable } from 'react-native'
import { styles } from './styles'

interface ChannelInfoProps {
  channelName: string
  channelInitial: string
  onSubscribe?: () => void
}

export const ChannelInfo = memo(function ChannelInfo({
  channelName,
  channelInitial,
  onSubscribe,
}: ChannelInfoProps) {
  return (
    <View style={styles.channelRow}>
      <View style={styles.channelAvatar}>
        <Text style={styles.channelAvatarText}>{channelInitial}</Text>
      </View>
      <View style={styles.channelInfo}>
        <Text style={styles.channelName}>{channelName}</Text>
        <Text style={styles.channelSubs}>Channel</Text>
      </View>
      <Pressable style={styles.subscribeButton} onPress={onSubscribe}>
        <Text style={styles.subscribeText}>Subscribe</Text>
      </Pressable>
    </View>
  )
})
