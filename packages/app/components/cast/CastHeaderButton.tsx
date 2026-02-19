/**
 * CastHeaderButton - Cast button + device picker for app headers.
 */

import { useState, useCallback } from 'react'
import { Alert } from 'react-native'
import { colors } from '@/lib/colors'
import { useCast } from '@/lib/cast'
import { CastButton } from './CastButton'
import { DevicePickerModal } from './DevicePickerModal'
import { CastRemoteModal } from './CastRemoteModal'

interface CastHeaderButtonProps {
  size?: number
  color?: string
  activeColor?: string
}

export function CastHeaderButton({
  size = 18,
  color = colors.text,
  activeColor = colors.primary,
}: CastHeaderButtonProps) {
  const cast = useCast()
  const [showCastPicker, setShowCastPicker] = useState(false)
  const [showCastRemote, setShowCastRemote] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectingDeviceId, setConnectingDeviceId] = useState<string | null>(null)
  const [recentDeviceId, setRecentDeviceId] = useState<string | null>(null)

  const openPicker = useCallback(() => {
    if (!cast.available) {
      Alert.alert('Chromecast', 'Cast is still initializing. If this persists, reopen the app.')
      return
    }
    if (cast.isConnected) {
      setShowCastRemote(true)
      return
    }
    setShowCastPicker(true)
    cast.startDiscovery()
  }, [cast])

  const closePicker = useCallback(() => {
    setShowCastPicker(false)
    cast.stopDiscovery()
  }, [cast])

  const handleSwitchDevice = useCallback(() => {
    setShowCastRemote(false)
    setShowCastPicker(true)
    cast.startDiscovery()
  }, [cast])

  const handleDeviceSelect = useCallback(async (deviceId: string) => {
    setIsConnecting(true)
    setConnectingDeviceId(deviceId)
    try {
      const success = await cast.connect(deviceId)
      if (!success) {
        Alert.alert('Chromecast', 'Failed to connect to Chromecast device.')
        return
      }
      setRecentDeviceId(deviceId)
      setShowCastPicker(false)
      setShowCastRemote(true)
    } finally {
      setIsConnecting(false)
      setConnectingDeviceId(null)
    }
  }, [cast])

  const handleDisconnect = useCallback(async () => {
    await cast.disconnect()
    setShowCastPicker(false)
    setShowCastRemote(false)
  }, [cast])

  return (
    <>
      <CastButton
        available={cast.available}
        isConnected={cast.isConnected}
        isConnecting={isConnecting}
        onPress={openPicker}
        size={size}
        color={color}
        activeColor={activeColor}
      />
      <DevicePickerModal
        visible={showCastPicker}
        devices={cast.devices}
        connectedDevice={cast.connectedDevice}
        connectingDeviceId={connectingDeviceId}
        recentDeviceId={recentDeviceId}
        isDiscovering={cast.isDiscovering}
        onClose={closePicker}
        onDeviceSelect={handleDeviceSelect}
        onDisconnect={handleDisconnect}
        onAddManualDevice={cast.addManualDevice}
        onRefresh={cast.startDiscovery}
      />
      <CastRemoteModal
        visible={showCastRemote}
        onClose={() => setShowCastRemote(false)}
        onSwitchDevice={handleSwitchDevice}
      />
    </>
  )
}

export default CastHeaderButton
