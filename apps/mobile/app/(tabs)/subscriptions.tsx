/**
 * Subscriptions Tab - Channels you follow
 */
import { useState, useCallback } from 'react'
import { View, Text, FlatList, RefreshControl, Alert, Pressable, TextInput } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { UserPlus, Users, Trash2 } from 'lucide-react-native'
import { useApp, colors } from '../_layout'

interface Subscription {
  channelKey: string
  name: string
  subscribedAt: number
}

// Validate channel key is 64 hex characters
const isValidChannelKey = (key: string) => /^[a-f0-9]{64}$/i.test(key)

export default function SubscriptionsScreen() {
  const insets = useSafeAreaInsets()
  const { rpc } = useApp()
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [channelKey, setChannelKey] = useState('')
  const [loading, setLoading] = useState(false)

  const loadSubscriptions = useCallback(async () => {
    if (!rpc) return
    try {
      const result = await rpc.getSubscriptions({})
      setSubscriptions(result?.subscriptions || [])
    } catch (err) {
      console.error('Failed to load subscriptions:', err)
    }
  }, [rpc])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await loadSubscriptions()
    setRefreshing(false)
  }, [loadSubscriptions])

  const subscribeToChannel = async () => {
    if (!rpc) return
    const key = channelKey.trim()
    if (!key) return

    // Validate key format
    if (!isValidChannelKey(key)) {
      Alert.alert('Invalid Key', 'Channel key must be 64 hexadecimal characters')
      return
    }

    setLoading(true)
    try {
      await rpc.subscribeChannel({ channelKey: key })
      await loadSubscriptions()
      setChannelKey('')
      Alert.alert('Subscribed', 'Successfully subscribed to channel')
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to subscribe')
    } finally {
      setLoading(false)
    }
  }

  const unsubscribe = async (key: string) => {
    if (!rpc) return
    Alert.alert(
      'Unsubscribe',
      'Are you sure you want to unsubscribe from this channel?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unsubscribe',
          style: 'destructive',
          onPress: async () => {
            try {
              await rpc.unsubscribeChannel({ channelKey: key })
              await loadSubscriptions()
            } catch (err: any) {
              Alert.alert('Error', err.message || 'Failed to unsubscribe')
            }
          },
        },
      ]
    )
  }

  return (
    <View className="flex-1 bg-pear-bg">
      {/* Header with safe area */}
      <View
        className="bg-pear-bg border-b border-pear-border"
        style={{ paddingTop: insets.top }}
      >
        <View className="px-5 py-4">
          <Text className="text-title text-pear-text">Subscriptions</Text>
          <Text className="text-caption text-pear-text-muted mt-1">Channels you follow</Text>
        </View>
      </View>

      {/* Subscribe Section */}
      <View className="px-5 py-5 border-b border-pear-border gap-3">
        <TextInput
          placeholder="Enter 64-character hex channel key"
          value={channelKey}
          onChangeText={setChannelKey}
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3.5 text-body text-pear-text"
        />
        <Pressable
          onPress={subscribeToChannel}
          disabled={loading || !channelKey.trim()}
          className={`flex-row items-center justify-center gap-2 bg-pear-primary rounded-lg py-3.5 ${(loading || !channelKey.trim()) ? 'opacity-50' : ''}`}
        >
          <UserPlus color="white" size={18} />
          <Text className="text-white text-label">Subscribe to Channel</Text>
        </Pressable>
      </View>

      {/* Subscriptions List */}
      <FlatList
        data={subscriptions}
        keyExtractor={(item) => item.channelKey}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: insets.bottom + 16,
          flexGrow: 1,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={
          <View className="flex-1 justify-center items-center py-16">
            <View className="w-16 h-16 rounded-full bg-pear-bg-card items-center justify-center mb-4">
              <Users color={colors.textMuted} size={28} />
            </View>
            <Text className="text-headline text-pear-text mb-2">No subscriptions yet</Text>
            <Text className="text-body text-pear-text-muted text-center px-8">
              Subscribe to channels to see their videos here
            </Text>
          </View>
        }
        ItemSeparatorComponent={() => <View className="h-3" />}
        renderItem={({ item }) => (
          <View className="flex-row bg-pear-bg-elevated rounded-xl p-4 items-center">
            {/* Avatar */}
            <View className="w-12 h-12 rounded-full bg-pear-bg-card justify-center items-center">
              <Text className="text-headline text-pear-text">
                {item.name?.charAt(0)?.toUpperCase() || '?'}
              </Text>
            </View>
            {/* Info */}
            <View className="flex-1 ml-4">
              <Text className="text-label text-pear-text">
                {item.name || 'Unknown Channel'}
              </Text>
              <Text className="text-caption text-pear-text-muted mt-0.5" numberOfLines={1}>
                {item.channelKey.substring(0, 32)}...
              </Text>
            </View>
            {/* Unsubscribe */}
            <Pressable
              onPress={() => unsubscribe(item.channelKey)}
              className="w-10 h-10 items-center justify-center"
            >
              <Trash2 color={colors.error} size={18} />
            </Pressable>
          </View>
        )}
      />
    </View>
  )
}
