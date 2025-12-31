/**
 * CastHeaderButton - Cast button + device picker for app headers.
 */

import { useState, useCallback } from 'react'
import { Alert } from 'react-native'
import { colors } from '@/lib/colors'
import { useCast } from '@/lib/cast'
import { CastButton } from './CastButton'
import { DevicePickerModal } from './DevicePickerModal'

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
  const [isConnecting, setIsConnecting] = useState(false)

  const openPicker = useCallback(() => {
    if (!cast.available) return
    setShowCastPicker(true)
    cast.startDiscovery()
  }, [cast])

  const closePicker = useCallback(() => {
    setShowCastPicker(false)
    cast.stopDiscovery()
  }, [cast])

  const handleDeviceSelect = useCallback(async (deviceId: string) => {
    setIsConnecting(true)
    try {
      const success = await cast.connect(deviceId)
      if (!success) {
        Alert.alert('Chromecast', 'Failed to connect to Chromecast device.')
        return
      }
      setShowCastPicker(false)
    } finally {
      setIsConnecting(false)
    }
  }, [cast])

  const handleDisconnect = useCallback(async () => {
    await cast.disconnect()
    setShowCastPicker(false)
  }, [cast])

  if (!cast.available) {
    return null
  }

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
        isDiscovering={cast.isDiscovering}
        onClose={closePicker}
        onDeviceSelect={handleDeviceSelect}
        onDisconnect={handleDisconnect}
        onAddManualDevice={cast.addManualDevice}
        onRefresh={cast.startDiscovery}
      />
    </>
  )
}

export default CastHeaderButton
