/**
 * DevicePickerModal - Modal to select cast devices
 *
 * Shows available Chromecast devices on the network.
 * Also allows adding devices manually by IP address.
 */

import { useState } from 'react'
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Platform,
} from 'react-native'
import { Feather } from '@expo/vector-icons'
import { colors, spacing, radius, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { ScreenHeader, Button, Meta } from '@/components/primitives'
import type { CastDevice } from '@/lib/cast'

interface DevicePickerModalProps {
  visible: boolean
  onClose: () => void
  devices: CastDevice[]
  connectedDevice: CastDevice | null
  connectingDeviceId?: string | null
  recentDeviceId?: string | null
  isDiscovering: boolean
  onDeviceSelect: (deviceId: string) => void
  onDisconnect: () => void
  onAddManualDevice: (name: string, host: string, port?: number, protocol?: string) => Promise<CastDevice | null>
  onRefresh: () => void
}

export function DevicePickerModal({
  visible,
  onClose,
  devices,
  connectedDevice,
  connectingDeviceId = null,
  recentDeviceId = null,
  isDiscovering,
  onDeviceSelect,
  onDisconnect,
  onAddManualDevice,
  onRefresh,
}: DevicePickerModalProps) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [manualName, setManualName] = useState('')
  const [manualHost, setManualHost] = useState('')
  const [manualPort, setManualPort] = useState('')
  const manualProtocol = 'chromecast'
  const [isAdding, setIsAdding] = useState(false)

  const sortedDevices = (() => {
    const list = Array.isArray(devices) ? [...devices] : []
    const connectedId = connectedDevice?.id
    list.sort((a, b) => {
      const aPinned = (a.id && (a.id === connectedId || a.id === recentDeviceId)) ? 1 : 0
      const bPinned = (b.id && (b.id === connectedId || b.id === recentDeviceId)) ? 1 : 0
      if (aPinned !== bPinned) return bPinned - aPinned
      return (a.name || '').localeCompare(b.name || '')
    })
    return list
  })()

  const handleAddManual = async () => {
    if (!manualHost.trim()) return

    setIsAdding(true)
    try {
      const port = manualPort ? parseInt(manualPort, 10) : undefined
      const device = await onAddManualDevice(
        manualName.trim() || `Chromecast @ ${manualHost}`,
        manualHost.trim(),
        port,
        manualProtocol
      )

      if (device) {
        setManualName('')
        setManualHost('')
        setManualPort('')
        setShowAdvanced(false)
      }
    } finally {
      setIsAdding(false)
    }
  }

  const handleDevicePress = (device: CastDevice) => {
    if (connectedDevice?.id === device.id) {
      onDisconnect()
    } else {
      onDeviceSelect(device.id)
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.modal}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>CAST TO</Text>
            <Pressable style={styles.closeButton} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close cast picker">
              <Feather name="x" size={24} color={colors.text} />
            </Pressable>
          </View>

          {/* Device List */}
          <ScrollView style={styles.deviceList}>
            {sortedDevices.length === 0 ? (
              <View style={styles.emptyState}>
                {isDiscovering ? (
                  <>
                    <ActivityIndicator size="large" color={colors.primary} />
                    <Meta tone="muted">LOOKING FOR DEVICES…</Meta>
                  </>
                ) : (
                  <>
                    <Feather name="cast" size={48} color={colors.textMuted} />
                    <Meta tone="default">NO DEVICES FOUND</Meta>
                    <Meta tone="muted" size="sm">Make sure your phone and cast device are on the same Wi-Fi.</Meta>
                    <Pressable style={styles.emptyRefresh} onPress={onRefresh}>
                      <Feather name="refresh-cw" size={16} color={colors.primary} />
                      <Meta tone="accent">REFRESH</Meta>
                    </Pressable>
                  </>
                )}
              </View>
            ) : (
              sortedDevices.map((device) => (
                <Pressable
                  key={device.id}
                  style={[
                    styles.deviceItem,
                    connectedDevice?.id === device.id && styles.deviceItemConnected,
                  ]}
                  onPress={() => handleDevicePress(device)}
                  disabled={Boolean(connectingDeviceId) && connectingDeviceId !== device.id}
                >
                  <View style={styles.deviceIcon}>
                    <Feather
                      name={device.protocol === 'chromecast' ? 'tv' : 'cast'}
                      size={24}
                      color={connectedDevice?.id === device.id ? colors.onPrimary : colors.text}
                    />
                  </View>
                  <View style={styles.deviceInfo}>
                    <Text style={[
                      styles.deviceName,
                      connectedDevice?.id === device.id && styles.deviceNameConnected,
                    ]}>
                      {device.name}
                    </Text>
                    <Meta tone="muted" size="sm">
                      {connectedDevice?.id === device.id
                        ? 'CONNECTED'
                        : (connectingDeviceId === device.id ? 'CONNECTING…' : 'AVAILABLE')}
                    </Meta>
                  </View>
                  {connectingDeviceId === device.id ? (
                    <ActivityIndicator size={16} color={colors.primary} />
                  ) : connectedDevice?.id === device.id ? (
                    <Feather name="check-circle" size={20} color={colors.primary} />
                  ) : null}
                </Pressable>
              ))
            )}
          </ScrollView>

          {/* Actions */}
          <View style={styles.actions}>
            <Button 
              label="Refresh" 
              variant="secondary" 
              size="sm"
              icon={isDiscovering ? undefined : 'refresh-cw'}
              onPress={onRefresh}
              disabled={isDiscovering}
            />
            <Button 
              label={showAdvanced ? 'Hide Advanced' : 'Advanced'}
              variant="ghost"
              size="sm"
              onPress={() => setShowAdvanced(!showAdvanced)}
            />
          </View>

          {/* Advanced section */}
          {showAdvanced && (
            <View style={styles.advancedSection}>
              <Meta tone="muted">MANUAL DEVICE</Meta>
              <TextInput
                style={styles.input}
                placeholder="Device name"
                placeholderTextColor={colors.textMuted}
                value={manualName}
                onChangeText={setManualName}
              />
              <TextInput
                style={styles.input}
                placeholder="Host IP address"
                placeholderTextColor={colors.textMuted}
                value={manualHost}
                onChangeText={setManualHost}
              />
              <TextInput
                style={styles.input}
                placeholder="Port (optional)"
                placeholderTextColor={colors.textMuted}
                value={manualPort}
                onChangeText={setManualPort}
                keyboardType="number-pad"
              />
              <Button
                label="Add device"
                variant="primary"
                size="sm"
                block
                onPress={handleAddManual}
                loading={isAdding}
                disabled={!manualHost.trim()}
              />
            </View>
          )}
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: 'flex-end',
  },
  modal: {
    backgroundColor: colors.surface,
    borderTopWidth: borderWidth.rule,
    borderTopColor: colors.primary,
    maxHeight: '80%',
    paddingBottom: spacing.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: colors.borderSubtle,
  },
  title: {
    ...fonts.title.md,
    color: colors.text,
    textTransform: 'uppercase',
  },
  closeButton: {
    padding: spacing.sm,
  },
  deviceList: {
    maxHeight: 300,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxxl,
    gap: spacing.lg,
  },
  emptyRefresh: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
  },
  deviceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.lg,
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: colors.borderSubtle,
    gap: spacing.md,
  },
  deviceItemConnected: {
    backgroundColor: colors.primaryLight,
  },
  deviceIcon: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: borderWidth.hairline,
    borderColor: colors.border,
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    ...fonts.label.md,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  deviceNameConnected: {
    color: colors.onPrimary,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
    borderTopWidth: borderWidth.hairline,
    borderTopColor: colors.borderSubtle,
  },
  advancedSection: {
    padding: spacing.lg,
    borderTopWidth: borderWidth.hairline,
    borderTopColor: colors.borderSubtle,
    gap: spacing.md,
  },
  input: {
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    backgroundColor: colors.bg,
    ...fonts.body.md,
  },
})

export default DevicePickerModal
