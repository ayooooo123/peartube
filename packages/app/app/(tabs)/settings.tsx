/**
 * Settings Tab - App and channel settings
 */
import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, Alert, Share, Clipboard, Pressable, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import DiagnosticsPanel from '@/components/native-diagnostics/DiagnosticsPanel'
import { NativeButton, NativeSwitch, NativeTextInput } from '@/components/native-ui'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather } from '@expo/vector-icons'
import { useApp, colors } from '../_layout'
import { CastHeaderButton } from '@/components/cast'
import { useTabBarMetrics } from '@/lib/tabBarHeight'
interface StorageStats {
  usedBytes: number
  maxBytes: number
  usedGB: string
  maxGB: number
  seedCount: number
  pinnedCount: number
}

interface TranscodeSettings {
  videoToolboxDecodeEnabled: boolean
  videoToolboxDecodeLocked?: boolean
  videoToolboxDecodeDefault?: boolean
  videoToolboxDecodeSource?: string
  videoToolboxHwMapEnabled?: boolean
  videoToolboxHwMapLocked?: boolean
  videoToolboxHwMapDefault?: boolean
  videoToolboxHwMapSource?: string
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { identity, createIdentity, rpc, loadIdentity } = useApp()
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null)
  const [storageLimit, setStorageLimit] = useState(5)
  const [customStorageLimit, setCustomStorageLimit] = useState('5')
  const [storageLimitSaving, setStorageLimitSaving] = useState(false)
  const [clearingCache, setClearingCache] = useState(false)
  const [isPublished, setIsPublished] = useState(false)
  const [publishLoading, setPublishLoading] = useState(false)
  const tabBarMetrics = useTabBarMetrics()
  const bottomPadding = Math.max(tabBarMetrics.height + 16, insets.bottom + 16)

  // Multi-device (multi-writer) channel
  const [devices, setDevices] = useState<any[]>([])
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const [inviteLoading, setInviteLoading] = useState(false)
  const [pairInviteCode, setPairInviteCode] = useState('')
  const [pairDeviceName, setPairDeviceName] = useState('')
  const [pairing, setPairing] = useState(false)
  const isPear = Platform.OS === 'web' && typeof window !== 'undefined' && (!!(window as any).Pear || !!(window as any).bridge)
  const canManageTranscodeSettings = isPear && typeof (rpc as any)?.getTranscodeSettings === 'function'
  const [transcodeSettings, setTranscodeSettings] = useState<TranscodeSettings | null>(null)
  const [transcodeSettingsLoading, setTranscodeSettingsLoading] = useState(false)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [swarmStatus, setSwarmStatus] = useState<any | null>(null)
  const [seedingStatus, setSeedingStatus] = useState<any | null>(null)
  const nativeButtonStyle = { width: '100%' }

  // Check if channel is published
  const checkPublishStatus = useCallback(async () => {
    if (!rpc || !identity?.driveKey) return
    try {
      const result = await rpc.isChannelPublished()
      setIsPublished(result.published)
    } catch (err) {
      console.error('[Settings] Failed to check publish status:', err)
    }
  }, [rpc, identity?.driveKey])

  useEffect(() => {
    checkPublishStatus()
  }, [checkPublishStatus])

  // Load storage stats
  const loadStorageStats = useCallback(async () => {
    if (!rpc) return
    try {
      const stats = await rpc.getStorageStats()
      setStorageStats(stats)
      setStorageLimit(stats.maxGB)
      setCustomStorageLimit(String(stats.maxGB))
    } catch (err) {
      console.error('[Settings] Failed to load storage stats:', err)
    }
  }, [rpc])

  useEffect(() => {
    loadStorageStats()
  }, [loadStorageStats])

  const loadDiagnostics = useCallback(async () => {
    if (!rpc) return
    setDiagnosticsLoading(true)
    try {
      const [swarm, seeding] = await Promise.all([
        typeof (rpc as any)?.getSwarmStatus === 'function' ? (rpc as any).getSwarmStatus() : Promise.resolve(null),
        typeof (rpc as any)?.getSeedingStatus === 'function' ? (rpc as any).getSeedingStatus() : Promise.resolve(null),
      ])
      setSwarmStatus(swarm || null)
      setSeedingStatus(seeding || null)
    } catch (err) {
      console.error('[Settings] Failed to load diagnostics:', err)
    } finally {
      setDiagnosticsLoading(false)
    }
  }, [rpc])

  useEffect(() => {
    loadDiagnostics()
  }, [loadDiagnostics])

  const loadDevices = useCallback(async () => {
    if (!rpc || !identity?.driveKey) return
    setDevicesLoading(true)
    try {
      const res = await (rpc as any).listDevices(identity.driveKey)
      setDevices(res?.devices || [])
    } catch (err) {
      console.error('[Settings] Failed to load devices:', err)
    } finally {
      setDevicesLoading(false)
    }
  }, [rpc, identity?.driveKey])

  useEffect(() => {
    loadDevices()
  }, [loadDevices])

  const loadTranscodeSettings = useCallback(async () => {
    if (!canManageTranscodeSettings) return
    setTranscodeSettingsLoading(true)
    try {
      const res = await (rpc as any).getTranscodeSettings()
      setTranscodeSettings(res?.settings || null)
    } catch (err) {
      console.error('[Settings] Failed to load transcode settings:', err)
    } finally {
      setTranscodeSettingsLoading(false)
    }
  }, [canManageTranscodeSettings, rpc])

  useEffect(() => {
    loadTranscodeSettings()
  }, [loadTranscodeSettings])

  const handleVideoToolboxDecodeToggle = async (enabled: boolean) => {
    if (!canManageTranscodeSettings) return
    setTranscodeSettings((prev) => ({
      ...(prev || { videoToolboxDecodeEnabled: enabled }),
      videoToolboxDecodeEnabled: enabled,
    }))
    setTranscodeSettingsLoading(true)
    try {
      const res = await (rpc as any).setTranscodeSettings({ videoToolboxDecodeEnabled: enabled })
      if (res?.success === false) {
        throw new Error(res?.error || 'Failed to update transcode settings')
      }
      setTranscodeSettings(res?.settings || null)
    } catch (err: any) {
      console.error('[Settings] Failed to update transcode settings:', err)
      if (Platform.OS === 'web') {
        window.alert(err?.message || 'Failed to update transcode settings')
      } else {
        Alert.alert('Error', err?.message || 'Failed to update transcode settings')
      }
      await loadTranscodeSettings()
    } finally {
      setTranscodeSettingsLoading(false)
    }
  }

  const handleVideoToolboxHwMapToggle = async (enabled: boolean) => {
    if (!canManageTranscodeSettings) return
    setTranscodeSettings((prev) => ({
      ...(prev || { videoToolboxDecodeEnabled: false, videoToolboxHwMapEnabled: enabled }),
      videoToolboxHwMapEnabled: enabled,
    }))
    setTranscodeSettingsLoading(true)
    try {
      const res = await (rpc as any).setTranscodeSettings({ videoToolboxHwMapEnabled: enabled })
      if (res?.success === false) {
        throw new Error(res?.error || 'Failed to update transcode settings')
      }
      setTranscodeSettings(res?.settings || null)
    } catch (err: any) {
      console.error('[Settings] Failed to update transcode settings:', err)
      if (Platform.OS === 'web') {
        window.alert(err?.message || 'Failed to update transcode settings')
      } else {
        Alert.alert('Error', err?.message || 'Failed to update transcode settings')
      }
      await loadTranscodeSettings()
    } finally {
      setTranscodeSettingsLoading(false)
    }
  }

  const createInvite = async () => {
    if (!rpc || !identity?.driveKey) return
    setInviteLoading(true)
    try {
      const res = await (rpc as any).createDeviceInvite(identity.driveKey)
      if (res?.inviteCode) {
        setInviteCode(res.inviteCode)
        if (Platform.OS === 'web') window.alert('Invite code created')
        else Alert.alert('Invite Created', 'Share this invite code with your other device.')
      }
    } catch (err: any) {
      console.error('[Settings] Failed to create invite:', err)
      if (Platform.OS === 'web') window.alert('Failed to create invite')
      else Alert.alert('Error', err?.message || 'Failed to create invite')
    } finally {
      setInviteLoading(false)
    }
  }

  const pairDevice = async () => {
    if (!rpc) return
    const code = pairInviteCode.trim()
    if (!code) return
    setPairing(true)
    try {
      const res = await (rpc as any).pairDevice({
        inviteCode: code,
        deviceName: pairDeviceName.trim() || undefined,
      })
      if (res?.success) {
        setPairInviteCode('')
        setPairDeviceName('')
        if (Platform.OS === 'web') window.alert('Device paired!')
        else Alert.alert('Paired', 'This device is now linked to your channel.')
        await loadDevices()
      } else {
        throw new Error('Pair failed')
      }
    } catch (err: any) {
      console.error('[Settings] Pair device failed:', err)
      if (Platform.OS === 'web') window.alert(err?.message || 'Failed to pair device')
      else Alert.alert('Error', err?.message || 'Failed to pair device')
    } finally {
      setPairing(false)
    }
  }

  const parseStorageLimitGB = (value: string): number | null => {
    const parsed = Number(value.trim())
    if (!Number.isFinite(parsed)) return null
    return Math.max(1, Math.min(100, Math.round(parsed)))
  }

  const handleStorageLimitChange = async (newLimit: number) => {
    if (!rpc) return
    const boundedLimit = Math.max(1, Math.min(100, Math.round(newLimit)))
    setStorageLimit(boundedLimit)
    setCustomStorageLimit(String(boundedLimit))
    setStorageLimitSaving(true)
    try {
      const result = await rpc.setStorageLimit(boundedLimit)
      if (result?.success === false) throw new Error('Failed to set storage limit')
      await loadStorageStats()
    } catch (err: any) {
      console.error('[Settings] Failed to set storage limit:', err)
      if (Platform.OS === 'web') window.alert(err?.message || 'Failed to set storage limit')
      else Alert.alert('Error', err?.message || 'Failed to set storage limit')
      await loadStorageStats()
    } finally {
      setStorageLimitSaving(false)
    }
  }

  const handleCustomStorageLimitApply = async () => {
    const parsed = parseStorageLimitGB(customStorageLimit)
    if (!parsed) {
      if (Platform.OS === 'web') window.alert('Enter a cache limit from 1 to 100 GB')
      else Alert.alert('Invalid Limit', 'Enter a cache limit from 1 to 100 GB')
      setCustomStorageLimit(String(storageLimit))
      return
    }
    await handleStorageLimitChange(parsed)
  }

  const handleClearCache = async () => {
    if (!rpc) return

    const confirmClear = () => {
      return new Promise<boolean>((resolve) => {
        if (Platform.OS === 'web') {
          resolve(window.confirm('Clear all cached peer content?\n\nThis will remove all downloaded videos from other channels (except pinned content). Your own videos are not affected.'))
        } else {
          Alert.alert(
            'Clear Cache',
            'This will remove all downloaded videos from other channels (except pinned content). Your own videos are not affected.',
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
              { text: 'Clear', style: 'destructive', onPress: () => resolve(true) },
            ]
          )
        }
      })
    }

    const confirmed = await confirmClear()
    if (!confirmed) return

    setClearingCache(true)
    try {
      const result = await rpc.clearCache()
      if (result.success) {
        const clearedMB = ((result.clearedBytes || 0) / (1024 * 1024)).toFixed(1)
        if (Platform.OS === 'web') {
          window.alert(`Cache cleared! Freed ${clearedMB} MB`)
        } else {
          Alert.alert('Cache Cleared', `Freed ${clearedMB} MB of storage`)
        }
        await loadStorageStats()
      }
    } catch (err) {
      console.error('[Settings] Failed to clear cache:', err)
    } finally {
      setClearingCache(false)
    }
  }

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
                  const result = await rpc.submitToFeed({})
                  if (!result?.success) throw new Error(result?.error || 'Failed to publish channel')
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

    setPublishLoading(true)
    // Use window.confirm on web (Pear desktop), Alert.alert on native
    if (Platform.OS === 'web') {
      const confirmed = window.confirm('Publish Channel?\n\nThis will add your channel to the public feed so others can discover it.')
      if (confirmed) {
        try {
          console.log('[Settings] Publishing to feed, driveKey:', identity.driveKey)
          const result = await rpc.submitToFeed()
          if (!result?.success) throw new Error(result?.error || 'Failed to publish channel')
          setIsPublished(true)
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
                const result = await rpc.submitToFeed()
                if (!result?.success) throw new Error(result?.error || 'Failed to publish channel')
                setIsPublished(true)
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
    setPublishLoading(false)
  }

  // Unpublish channel from public feed
  const unpublishFromFeed = async () => {
    if (!identity?.driveKey || !rpc) return

    setPublishLoading(true)
    if (Platform.OS === 'web') {
      const confirmed = window.confirm('Unpublish Channel?\n\nThis will remove your channel from the public feed. Others will no longer discover it through the feed.')
      if (confirmed) {
        try {
          console.log('[Settings] Unpublishing from feed, driveKey:', identity.driveKey)
          await rpc.unpublishFromFeed()
          setIsPublished(false)
          window.alert('Unpublished! Your channel is no longer on the public feed.')
        } catch (err) {
          console.error('Failed to unpublish:', err)
          window.alert('Error: Failed to unpublish channel')
        }
      }
    } else {
      Alert.alert(
        'Unpublish Channel?',
        'This will remove your channel from the public feed. Others will no longer discover it through the feed.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Unpublish',
            style: 'destructive',
            onPress: async () => {
              try {
                await rpc.unpublishFromFeed()
                setIsPublished(false)
                Alert.alert('Unpublished!', 'Your channel is no longer on the public feed.')
              } catch (err) {
                console.error('Failed to unpublish:', err)
                Alert.alert('Error', 'Failed to unpublish channel')
              }
            },
          },
        ]
      )
    }
    setPublishLoading(false)
  }

  const renderStorageSection = () => (
    <View className="px-5 py-5">
      <Text className="text-caption-medium text-pear-text-muted mb-4 uppercase tracking-wide">Storage</Text>

      <View className="bg-pear-bg-elevated rounded-xl p-4 mb-3">
        <View className="flex-row items-center mb-3">
          <View className="w-10 h-10 rounded-lg bg-pear-primary-muted items-center justify-center">
            <Feather name="hard-drive" color={colors.primary} size={20} />
          </View>
          <View className="flex-1 ml-4">
            <Text className="text-label text-pear-text">Peer Content Cache</Text>
            <Text className="text-caption text-pear-text-muted mt-0.5">
              {storageStats ? `${storageStats.usedGB} GB / ${storageStats.maxGB} GB used` : 'Loading...'}
            </Text>
          </View>
        </View>

        {storageStats && (
          <View className="mb-4">
            <View className="h-2 bg-pear-bg-card rounded-full overflow-hidden">
              <View
                className="h-full bg-pear-primary rounded-full"
                style={{ width: `${Math.min(100, storageStats.maxBytes > 0 ? (storageStats.usedBytes / storageStats.maxBytes) * 100 : 0)}%` }}
              />
            </View>
            <Text className="text-caption text-pear-text-muted mt-2">
              {storageStats.seedCount} cached videos • {storageStats.pinnedCount} pinned channels
            </Text>
          </View>
        )}

        <View className="mb-4">
          <Text className="text-caption text-pear-text-muted mb-2">Storage Limit</Text>
          <View className="flex-row gap-2 mb-3">
            {[5, 10, 20, 50].map((gb) => (
              <Pressable
                key={gb}
                onPress={() => handleStorageLimitChange(gb)}
                disabled={storageLimitSaving}
                className={`flex-1 py-2 rounded-lg items-center ${storageLimit === gb ? 'bg-pear-primary' : 'bg-pear-bg-card border border-pear-border'} ${storageLimitSaving ? 'opacity-50' : ''}`}
              >
                <Text className={`text-label ${storageLimit === gb ? 'text-white' : 'text-pear-text'}`}>
                  {gb} GB
                </Text>
              </Pressable>
            ))}
          </View>
          <View className="flex-row gap-2">
            <NativeTextInput
              value={customStorageLimit}
              onChangeText={setCustomStorageLimit}
              onSubmitEditing={handleCustomStorageLimitApply}
              keyboardType="numeric"
              placeholder="Custom GB"
              placeholderTextColor={colors.textMuted}
              className="flex-1 bg-pear-bg-input border border-pear-border rounded-lg px-4 py-2.5 text-body text-pear-text"
            />
            <Pressable
              onPress={handleCustomStorageLimitApply}
              disabled={storageLimitSaving}
              className={`px-4 py-2.5 rounded-lg items-center justify-center bg-pear-primary ${storageLimitSaving ? 'opacity-50' : ''}`}
            >
              <Text className="text-white text-label">{storageLimitSaving ? 'Saving...' : 'Apply Limit'}</Text>
            </Pressable>
          </View>
          <Text className="text-caption text-pear-text-muted mt-2">
            Set any cache budget from 1 to 100 GB. No channel/account is required.
          </Text>
        </View>

        <Pressable
          onPress={handleClearCache}
          disabled={clearingCache}
          className={`flex-row items-center justify-center gap-2 bg-pear-bg-card border border-pear-border rounded-lg py-2.5 ${clearingCache ? 'opacity-50' : ''}`}
        >
          <Feather name="trash-2" color={colors.text} size={16} />
          <Text className="text-pear-text text-label">
            {clearingCache ? 'Clearing...' : 'Clear Cache'}
          </Text>
        </Pressable>
      </View>

      <Text className="text-caption text-pear-text-muted">
        Cached content from other channels. Higher limits help the network by seeding more content to other peers. Your own videos are stored separately and do not count toward this limit.
      </Text>
    </View>
  )

  // Onboarding - no identity yet
  if (!identity) {
    return (
      <View className="flex-1 bg-pear-bg">
        <ScrollView
          contentContainerStyle={{ paddingBottom: bottomPadding, paddingTop: Math.max(insets.top + 32, 48) }}
          showsVerticalScrollIndicator={false}
        >
          <View className="items-center mb-8 px-6">
            <Text className="text-display text-pear-text mb-2">PearTube</Text>
            <Text className="text-body text-pear-text-muted text-center">P2P Video Streaming</Text>
          </View>

          {renderStorageSection()}

          <DiagnosticsPanel
            swarmStatus={swarmStatus}
            storageStats={storageStats}
            seedingStatus={seedingStatus}
            loading={diagnosticsLoading}
            onRefresh={loadDiagnostics}
          />

          <View className="h-2 bg-pear-bg-card" />

          <View className="px-5 py-5">
            <Text className="text-caption-medium text-pear-text-muted mb-4 uppercase tracking-wide">Channel</Text>
            <View className="gap-4">
              <View className="bg-pear-bg-elevated border border-pear-border rounded-xl p-4">
                <Text className="text-label text-pear-text mb-2">Already have an invite code?</Text>
                <Text className="text-caption text-pear-text-muted mb-3">
                  Pair this device to an existing channel so it can sync and upload from multiple devices.
                </Text>
                <NativeTextInput
                  placeholder="Paste invite code"
                  value={pairInviteCode}
                  onChangeText={setPairInviteCode}
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3 text-body text-pear-text mb-3"
                />
                <NativeTextInput
                  placeholder="Optional device name"
                  value={pairDeviceName}
                  onChangeText={setPairDeviceName}
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3 text-body text-pear-text mb-3"
                />
                <NativeButton
                  label={pairing ? 'Pairing...' : 'Pair & Continue'}
                  onPress={async () => {
                    await pairDevice()
                    await loadIdentity()
                  }}
                  disabled={pairing || !pairInviteCode.trim()}
                  variant="filled"
                  style={nativeButtonStyle}
                />
              </View>

              <NativeTextInput
                placeholder="Enter your channel name"
                value={newName}
                onChangeText={setNewName}
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3.5 text-body text-pear-text"
              />
              <NativeButton
                label={creating ? 'Creating...' : 'Create Channel'}
                onPress={handleCreateIdentity}
                disabled={creating || !newName.trim()}
                variant="filled"
                style={nativeButtonStyle}
              />
            </View>
          </View>
        </ScrollView>
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
          <View className="flex-row items-center justify-between">
            <Text className="text-title text-pear-text">Settings</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <CastHeaderButton size={18} />
              <Pressable onPress={() => router.push('/search')} className="p-2">
                <Feather name="search" color={colors.text} size={18} />
              </Pressable>
            </View>
          </View>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomPadding }}
        showsVerticalScrollIndicator={false}
      >
        {/* Your Channel Section */}
        <View className="px-5 py-5">
          <Text className="text-caption-medium text-pear-text-muted mb-4 uppercase tracking-wide">Your Channel</Text>

          {/* Channel Name */}
          <View className="flex-row bg-pear-bg-elevated rounded-xl p-4 mb-3 items-center">
            <View className="w-10 h-10 rounded-lg bg-pear-primary-muted items-center justify-center">
              <Feather name="user" color={colors.primary} size={20} />
            </View>
            <View className="flex-1 ml-4">
              <Text className="text-caption text-pear-text-muted">Channel Name</Text>
              <Text className="text-label text-pear-text mt-0.5">{identity.name}</Text>
            </View>
          </View>

          {/* Channel Key */}
          <View className="bg-pear-bg-elevated rounded-xl p-4 mb-3">
            <View className="flex-row items-center mb-3">
              <Feather name="key" color={colors.primary} size={16} />
              <Text className="text-caption text-pear-text-muted ml-2">Channel Key</Text>
            </View>
            <Text className="text-caption text-pear-text font-mono mb-4" numberOfLines={2}>
              {identity.driveKey}
            </Text>
            <View className="flex-row gap-3">
              <Pressable
                onPress={() => identity.driveKey && copyToClipboard(identity.driveKey, 'Channel key')}
                className="flex-1 flex-row items-center justify-center gap-2 bg-pear-bg-card border border-pear-border rounded-lg py-2.5"
              >
                <Feather name="copy" color={colors.text} size={16} />
                <Text className="text-pear-text text-label">Copy</Text>
              </Pressable>
              <Pressable
                onPress={shareChannelKey}
                className="flex-1 flex-row items-center justify-center gap-2 bg-pear-primary rounded-lg py-2.5"
              >
                <Feather name="share-2" color="white" size={16} />
                <Text className="text-white text-label">Share</Text>
              </Pressable>
            </View>
          </View>

          {/* Public Key */}
          <View className="bg-pear-bg-elevated rounded-xl p-4 mb-3">
            <View className="flex-row items-center mb-3">
              <Feather name="key" color={colors.textMuted} size={16} />
              <Text className="text-caption text-pear-text-muted ml-2">Public Key</Text>
            </View>
            <Text className="text-caption text-pear-text font-mono mb-4" numberOfLines={2}>
              {identity.publicKey}
            </Text>
            <Pressable
              onPress={() => copyToClipboard(identity.publicKey, 'Public key')}
              className="flex-row items-center justify-center gap-2 bg-pear-bg-card border border-pear-border rounded-lg py-2.5"
            >
              <Feather name="copy" color={colors.text} size={16} />
              <Text className="text-pear-text text-label">Copy Public Key</Text>
            </Pressable>
          </View>

          {/* Publish/Unpublish to Public Feed */}
          {isPublished ? (
            <>
              <View className="flex-row items-center justify-center gap-2 bg-pear-bg-elevated rounded-xl py-4 mb-2">
                <Feather name="globe" color={colors.primary} size={18} />
                <Text className="text-pear-primary text-label font-semibold">Published to Public Feed</Text>
              </View>
              <Pressable
                onPress={unpublishFromFeed}
                disabled={publishLoading}
                className={`flex-row items-center justify-center gap-2 bg-pear-bg-card border border-pear-border rounded-xl py-3 ${publishLoading ? 'opacity-50' : ''}`}
              >
                <Feather name="x" color={colors.textMuted} size={16} />
                <Text className="text-pear-text-muted text-label">
                  {publishLoading ? 'Updating...' : 'Unpublish from Feed'}
                </Text>
              </Pressable>
              <Text className="text-caption text-pear-text-muted text-center mt-2">
                Your channel is discoverable by other peers
              </Text>
            </>
          ) : (
            <>
              <Pressable
                onPress={publishToFeed}
                disabled={publishLoading}
                className={`flex-row items-center justify-center gap-2 bg-pear-primary rounded-xl py-4 ${publishLoading ? 'opacity-50' : ''}`}
              >
                <Feather name="globe" color="white" size={18} />
                <Text className="text-white text-label font-semibold">
                  {publishLoading ? 'Publishing...' : 'Publish to Public Feed'}
                </Text>
              </Pressable>
              <Text className="text-caption text-pear-text-muted text-center mt-2">
                Make your channel discoverable by other peers
              </Text>
            </>
          )}
        </View>

        {/* Devices Section */}
        <View className="px-5 py-5">
          <Text className="text-caption-medium text-pear-text-muted mb-4 uppercase tracking-wide">Devices</Text>

          {/* Invite */}
          <View className="bg-pear-bg-elevated rounded-xl p-4 mb-3">
            <Text className="text-label text-pear-text mb-2">Add another device</Text>
            <Text className="text-caption text-pear-text-muted mb-3">
              Generate an invite code on one device, then paste it into the other device to sync this channel.
            </Text>

            {inviteCode ? (
              <View className="bg-pear-bg-card border border-pear-border rounded-lg p-3 mb-3">
                <Text className="text-caption text-pear-text-muted mb-1">Invite Code</Text>
                <Text className="text-caption text-pear-text font-mono" selectable>
                  {inviteCode}
                </Text>
              </View>
            ) : null}

            <View className="flex-row gap-3">
              <Pressable
                onPress={createInvite}
                disabled={inviteLoading}
                className={`flex-1 flex-row items-center justify-center gap-2 bg-pear-primary rounded-lg py-2.5 ${inviteLoading ? 'opacity-50' : ''}`}
              >
                <Feather name="key" color="white" size={16} />
                <Text className="text-white text-label">{inviteLoading ? 'Creating...' : 'Create Invite'}</Text>
              </Pressable>

              <Pressable
                onPress={() => inviteCode && copyToClipboard(inviteCode, 'Invite code')}
                disabled={!inviteCode}
                className={`flex-1 flex-row items-center justify-center gap-2 bg-pear-bg-card border border-pear-border rounded-lg py-2.5 ${!inviteCode ? 'opacity-50' : ''}`}
              >
                <Feather name="copy" color={colors.text} size={16} />
                <Text className="text-pear-text text-label">Copy</Text>
              </Pressable>
            </View>
          </View>

          {/* Pair */}
          <View className="bg-pear-bg-elevated rounded-xl p-4 mb-3">
            <Text className="text-label text-pear-text mb-2">Join with invite code</Text>
            <NativeTextInput
              placeholder="Paste invite code"
              value={pairInviteCode}
              onChangeText={setPairInviteCode}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3 text-body text-pear-text mb-3"
            />
            <NativeTextInput
              placeholder="Optional device name (e.g. Studio MacBook)"
              value={pairDeviceName}
              onChangeText={setPairDeviceName}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              className="bg-pear-bg-input border border-pear-border rounded-lg px-4 py-3 text-body text-pear-text mb-3"
            />
            <Pressable
              onPress={pairDevice}
              disabled={pairing || !pairInviteCode.trim()}
              className={`flex-row items-center justify-center gap-2 bg-pear-bg-card border border-pear-border rounded-lg py-2.5 ${(pairing || !pairInviteCode.trim()) ? 'opacity-50' : ''}`}
            >
              <Feather name="user" color={colors.text} size={16} />
              <Text className="text-pear-text text-label">{pairing ? 'Pairing...' : 'Pair Device'}</Text>
            </Pressable>
          </View>

          {/* Device list */}
          <View className="bg-pear-bg-elevated rounded-xl p-4">
            <View className="flex-row items-center justify-between mb-3">
              <Text className="text-label text-pear-text">Linked devices</Text>
              <Pressable onPress={loadDevices} className="px-3 py-1 rounded-lg bg-pear-bg-card border border-pear-border">
                <Text className="text-pear-text text-caption">{devicesLoading ? 'Loading...' : 'Refresh'}</Text>
              </Pressable>
            </View>

            {devices?.length ? (
              <View className="gap-2">
                {devices.map((d, idx) => (
                  <View key={`${d?.keyHex || idx}`} className="bg-pear-bg-card border border-pear-border rounded-lg p-3">
                    <Text className="text-label text-pear-text">{d?.deviceName || 'Device'}</Text>
                    <Text className="text-caption text-pear-text-muted font-mono" numberOfLines={1}>
                      {d?.keyHex || ''}
                    </Text>
                    {d?.blobDriveKey ? (
                      <Text className="text-caption text-pear-text-muted font-mono" numberOfLines={1}>
                        blob: {d.blobDriveKey}
                      </Text>
                    ) : null}
                  </View>
                ))}
              </View>
            ) : (
              <Text className="text-caption text-pear-text-muted">
                {devicesLoading ? 'Loading devices…' : 'No linked devices yet.'}
              </Text>
            )}
          </View>
        </View>

        {/* Divider */}
        <View className="h-2 bg-pear-bg-card" />

        {/* Storage Section */}
        {renderStorageSection()}

        <DiagnosticsPanel
          swarmStatus={swarmStatus}
          storageStats={storageStats}
          seedingStatus={seedingStatus}
          loading={diagnosticsLoading}
          onRefresh={loadDiagnostics}
        />

        {/* Divider */}
        <View className="h-2 bg-pear-bg-card" />

        {canManageTranscodeSettings ? (
          <>
            {/* Transcoding Section */}
            <View className="px-5 py-5">
              <Text className="text-caption-medium text-pear-text-muted mb-4 uppercase tracking-wide">Transcoding</Text>

              <View className="bg-pear-bg-elevated rounded-xl p-4 mb-3">
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 pr-4">
                    <Text className="text-label text-pear-text">VideoToolbox Decode (Pear)</Text>
                    <Text className="text-caption text-pear-text-muted mt-0.5">
                      Use hardware decode on Pear to reduce CPU load. Disable if you see crashes or unstable playback.
                    </Text>
                  </View>
                  <NativeSwitch
                    value={!!transcodeSettings?.videoToolboxDecodeEnabled}
                    onValueChange={handleVideoToolboxDecodeToggle}
                    disabled={transcodeSettingsLoading || !!transcodeSettings?.videoToolboxDecodeLocked}
                    trackColor={{ false: colors.border, true: colors.primary }}
                    thumbColor={colors.text}
                  />
                </View>

                {transcodeSettingsLoading ? (
                  <Text className="text-caption text-pear-text-muted mt-3">Loading transcode settings...</Text>
                ) : transcodeSettings ? (
                  <>
                    {transcodeSettings.videoToolboxDecodeLocked ? (
                      <Text className="text-caption text-pear-text-muted mt-3">
                        Locked by environment override (PEARTUBE_ENABLE_VT_DECODE).
                      </Text>
                    ) : null}
                  <Text className="text-caption text-pear-text-muted mt-3">
                    Default: {transcodeSettings.videoToolboxDecodeDefault ? 'On' : 'Off'} • Source: {transcodeSettings.videoToolboxDecodeSource}
                  </Text>
                </>
              ) : (
                <Text className="text-caption text-pear-text-muted mt-3">Transcode settings unavailable.</Text>
              )}

              <View className="mt-4 pt-4 border-t border-pear-border">
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 pr-4">
                    <Text className="text-label text-pear-text">VideoToolbox HW Map (Pear)</Text>
                    <Text className="text-caption text-pear-text-muted mt-0.5">
                      Map hardware frames for read-only access instead of copying. Use for troubleshooting transferData errors.
                    </Text>
                  </View>
                  <NativeSwitch
                    value={!!transcodeSettings?.videoToolboxHwMapEnabled}
                    onValueChange={handleVideoToolboxHwMapToggle}
                    disabled={
                      transcodeSettingsLoading ||
                      !!transcodeSettings?.videoToolboxHwMapLocked ||
                      !transcodeSettings?.videoToolboxDecodeEnabled
                    }
                    trackColor={{ false: colors.border, true: colors.primary }}
                    thumbColor={colors.text}
                  />
                </View>

                {transcodeSettingsLoading ? (
                  <Text className="text-caption text-pear-text-muted mt-3">Loading transcode settings...</Text>
                ) : transcodeSettings ? (
                  <>
                    {transcodeSettings.videoToolboxHwMapLocked ? (
                      <Text className="text-caption text-pear-text-muted mt-3">
                        Locked by environment override (PEARTUBE_ENABLE_VT_HWMAP).
                      </Text>
                    ) : null}
                    {!transcodeSettings.videoToolboxDecodeEnabled ? (
                      <Text className="text-caption text-pear-text-muted mt-3">
                        Enable VideoToolbox Decode to apply this setting.
                      </Text>
                    ) : null}
                    <Text className="text-caption text-pear-text-muted mt-3">
                      Default: {transcodeSettings.videoToolboxHwMapDefault ? 'On' : 'Off'} • Source: {transcodeSettings.videoToolboxHwMapSource}
                    </Text>
                  </>
                ) : null}
              </View>
            </View>

              <Text className="text-caption text-pear-text-muted">
                Applies to Pear desktop only. Changes take effect for new transcode sessions.
              </Text>
            </View>

            {/* Divider */}
            <View className="h-2 bg-pear-bg-card" />
          </>
        ) : null}

        {/* About Section */}
        <View className="px-5 py-5">
          <Text className="text-caption-medium text-pear-text-muted mb-4 uppercase tracking-wide">About</Text>

          <View className="flex-row bg-pear-bg-elevated rounded-xl p-4 mb-3 items-center">
            <View className="w-10 h-10 rounded-lg bg-pear-primary-muted items-center justify-center">
              <Feather name="info" color={colors.primary} size={20} />
            </View>
            <View className="flex-1 ml-4">
              <Text className="text-label text-pear-text">PearTube Mobile</Text>
              <Text className="text-caption text-pear-text-muted mt-0.5">Version 1.0.0</Text>
            </View>
          </View>

          <View className="flex-row bg-pear-bg-elevated rounded-xl p-4 items-center">
            <View className="w-10 h-10 rounded-lg bg-pear-bg-card items-center justify-center">
              <Feather name="external-link" color={colors.textMuted} size={20} />
            </View>
        <Text className="flex-1 ml-4 text-body text-pear-text">Powered by Hyperswarm & Hyperblobs</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  )
}
