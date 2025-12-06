/**
 * Settings Tab - App and channel settings
 */
import { useState } from 'react'
import { View, Text, ScrollView, Alert, Share, Clipboard, Pressable, TextInput, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Copy, Share2, User, Key, Info, ExternalLink, Globe } from 'lucide-react-native'
import { useApp, colors } from '../_layout'

export default function SettingsScreen() {
  const insets = useSafeAreaInsets()
  const { identity, createIdentity, rpc } = useApp()
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await Clipboard.setString(text)
      Alert.alert('Copied', `${label} copied to clipboard`)
    } catch (err) {
      Alert.alert('Error', 'Failed to copy to clipboard')
    }
  }

  const shareChannelKey = async () => {
    if (!identity?.driveKey) return

    try {
      await Share.share({
        message: `Subscribe to my PearTube channel: ${identity.driveKey}`,
        title: 'Share Channel',
      })
    } catch (err) {
      console.error('Share failed:', err)
    }
  }

  const handleCreateIdentity = async () => {
    if (!newName.trim()) return

    setCreating(true)
    try {
      const newIdentity = await createIdentity(newName.trim())
      setNewName('')

      // Prompt user to publish channel to public feed
      if (newIdentity?.driveKey && rpc) {
        Alert.alert(
          'Publish to Public Feed?',
          'Would you like to add your channel to the public feed so others can discover it? You can keep it private if you prefer.',
          [
            {
              text: 'Keep Private',
              style: 'cancel',
            },
            {
              text: 'Publish',
              onPress: async () => {
                try {
                  await rpc.submitToFeed({})
                  Alert.alert('Published!', 'Your channel is now visible on the public feed.')
                } catch (err) {
                  console.error('Failed to publish to feed:', err)
                }
              },
            },
          ]
        )
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to create identity')
    } finally {
      setCreating(false)
    }
  }

  // Publish existing channel to public feed
  const publishToFeed = async () => {
    if (!identity?.driveKey || !rpc) return

    // Use window.confirm on web (Pear desktop), Alert.alert on native
    if (Platform.OS === 'web') {
      const confirmed = window.confirm('Publish Channel?\n\nThis will add your channel to the public feed so others can discover it.')
      if (confirmed) {
        try {
          console.log('[Settings] Publishing to feed, driveKey:', identity.driveKey)
          await rpc.submitToFeed({})
          window.alert('Published! Your channel is now visible on the public feed.')
        } catch (err) {
          console.error('Failed to publish:', err)
          window.alert('Error: Failed to publish channel')
        }
      }
    } else {
      Alert.alert(
        'Publish Channel?',
        'This will add your channel to the public feed so others can discover it.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Publish',
            onPress: async () => {
              try {
                await rpc.submitToFeed({})
                Alert.alert('Published!', 'Your channel is now visible on the public feed.')
              } catch (err) {
                console.error('Failed to publish:', err)
                Alert.alert('Error', 'Failed to publish channel')
              }
            },
          },
        ]
      )
    }
  }

  // Onboarding - no identity yet
  if (!identity) {
    return (
      <View className="flex-1 bg-pear-bg justify-center items-center px-6">
        <View className="items-center mb-12">
          <Text className="text-display text-pear-text mb-2">PearTube</Text>
          <Text className="text-body text-pear-text-muted text-center">P2P Video Streaming</Text>
        </View>

        <View className="w-full max-w-sm gap-4">
          <TextInput
            placeholder="Enter your channel name"
            value={newName}
            onChangeText={setNewName}
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3.5 text-body text-pear-text"
          />
          <Pressable
            onPress={handleCreateIdentity}
            disabled={creating || !newName.trim()}
            className={`bg-pear-primary rounded-lg py-3.5 items-center ${(creating || !newName.trim()) ? 'opacity-50' : ''}`}
          >
            <Text className="text-white text-label">
              {creating ? 'Creating...' : 'Create Channel'}
            </Text>
          </Pressable>
        </View>
      </View>
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
          <Text className="text-title text-pear-text">Settings</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Your Channel Section */}
        <View className="px-5 py-5">
          <Text className="text-caption-medium text-pear-text-muted mb-4 uppercase tracking-wide">Your Channel</Text>

          {/* Channel Name */}
          <View className="flex-row bg-pear-bg-elevated rounded-xl p-4 mb-3 items-center">
            <View className="w-10 h-10 rounded-lg bg-pear-primary-muted items-center justify-center">
              <User color={colors.primary} size={20} />
            </View>
            <View className="flex-1 ml-4">
              <Text className="text-caption text-pear-text-muted">Channel Name</Text>
              <Text className="text-label text-pear-text mt-0.5">{identity.name}</Text>
            </View>
          </View>

          {/* Channel Key */}
          <View className="bg-pear-bg-elevated rounded-xl p-4 mb-3">
            <View className="flex-row items-center mb-3">
              <Key color={colors.primary} size={16} />
              <Text className="text-caption text-pear-text-muted ml-2">Channel Key</Text>
            </View>
            <Text className="text-caption text-pear-text font-mono mb-4" numberOfLines={2}>
              {identity.driveKey}
            </Text>
            <View className="flex-row gap-3">
              <Pressable
                onPress={() => copyToClipboard(identity.driveKey, 'Channel key')}
                className="flex-1 flex-row items-center justify-center gap-2 bg-pear-bg-card border border-pear-border rounded-lg py-2.5"
              >
                <Copy color={colors.text} size={16} />
                <Text className="text-pear-text text-label">Copy</Text>
              </Pressable>
              <Pressable
                onPress={shareChannelKey}
                className="flex-1 flex-row items-center justify-center gap-2 bg-pear-primary rounded-lg py-2.5"
              >
                <Share2 color="white" size={16} />
                <Text className="text-white text-label">Share</Text>
              </Pressable>
            </View>
          </View>

          {/* Public Key */}
          <View className="bg-pear-bg-elevated rounded-xl p-4 mb-3">
            <View className="flex-row items-center mb-3">
              <Key color={colors.textMuted} size={16} />
              <Text className="text-caption text-pear-text-muted ml-2">Public Key</Text>
            </View>
            <Text className="text-caption text-pear-text font-mono mb-4" numberOfLines={2}>
              {identity.publicKey}
            </Text>
            <Pressable
              onPress={() => copyToClipboard(identity.publicKey, 'Public key')}
              className="flex-row items-center justify-center gap-2 bg-pear-bg-card border border-pear-border rounded-lg py-2.5"
            >
              <Copy color={colors.text} size={16} />
              <Text className="text-pear-text text-label">Copy Public Key</Text>
            </Pressable>
          </View>

          {/* Publish to Public Feed */}
          <Pressable
            onPress={publishToFeed}
            className="flex-row items-center justify-center gap-2 bg-pear-primary rounded-xl py-4"
          >
            <Globe color="white" size={18} />
            <Text className="text-white text-label font-semibold">Publish to Public Feed</Text>
          </Pressable>
          <Text className="text-caption text-pear-text-muted text-center mt-2">
            Make your channel discoverable by other peers
          </Text>
        </View>

        {/* Divider */}
        <View className="h-2 bg-pear-bg-card" />

        {/* About Section */}
        <View className="px-5 py-5">
          <Text className="text-caption-medium text-pear-text-muted mb-4 uppercase tracking-wide">About</Text>

          <View className="flex-row bg-pear-bg-elevated rounded-xl p-4 mb-3 items-center">
            <View className="w-10 h-10 rounded-lg bg-pear-primary-muted items-center justify-center">
              <Info color={colors.primary} size={20} />
            </View>
            <View className="flex-1 ml-4">
              <Text className="text-label text-pear-text">PearTube Mobile</Text>
              <Text className="text-caption text-pear-text-muted mt-0.5">Version 1.0.0</Text>
            </View>
          </View>

          <View className="flex-row bg-pear-bg-elevated rounded-xl p-4 items-center">
            <View className="w-10 h-10 rounded-lg bg-pear-bg-card items-center justify-center">
              <ExternalLink color={colors.textMuted} size={20} />
            </View>
            <Text className="flex-1 ml-4 text-body text-pear-text">Powered by Hyperswarm & Hyperdrive</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  )
}
