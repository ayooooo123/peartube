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
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
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
            <Text style={styles.title}>Cast</Text>
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
                    <Text style={styles.emptyText}>Looking for devices…</Text>
                  </>
                ) : (
                  <>
                    <Feather name="cast" size={48} color={colors.textMuted} />
                    <Text style={styles.emptyText}>No devices found</Text>
                    <Text style={styles.emptySubtext}>
                      Make sure your phone and cast device are on the same Wi-Fi.
                    </Text>
                    <Pressable style={styles.emptyRefresh} onPress={onRefresh}>
                      <Feather name="refresh-cw" size={16} color={colors.primary} />
                      <Text style={styles.emptyRefreshText}>Refresh</Text>
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
                      color={connectedDevice?.id === device.id ? colors.primary : colors.text}
                    />
                  </View>
                  <View style={styles.deviceInfo}>
                    <Text style={[
                      styles.deviceName,
                      connectedDevice?.id === device.id && styles.deviceNameConnected,
                    ]}>
                      {device.name}
                    </Text>
                    <Text style={styles.deviceMeta}>
                      {connectedDevice?.id === device.id
                        ? 'Connected'
                        : (connectingDeviceId === device.id ? 'Connecting…' : 'Tap to connect')}
                    </Text>
                  </View>
                  {connectingDeviceId === device.id ? (
                    <ActivityIndicator size={16} color={colors.primary} />
                  ) : connectedDevice?.id === device.id ? (
                    <View style={styles.connectedBadge}>
                      <Text style={styles.connectedText}>Connected</Text>
                    </View>
                  ) : null}
                </Pressable>
              ))
            )}
          </ScrollView>

          {/* Actions */}
          <View style={styles.actions}>
            <Pressable style={styles.actionButton} onPress={onRefresh}>
              {isDiscovering ? (
                <ActivityIndicator size={16} color={colors.primary} />
              ) : (
                <Feather name="refresh-cw" size={16} color={colors.primary} />
              )}
              <Text style={styles.actionText}>Refresh</Text>
            </Pressable>

            <Pressable
              style={styles.actionButton}
              onPress={() => setShowAdvanced(!showAdvanced)}
            >
              <Feather name={showAdvanced ? 'chevron-down' : 'chevron-up'} size={16} color={colors.primary} />
              <Text style={styles.actionText}>Advanced</Text>
            </Pressable>
          </View>

          {/* Manual Input */}
          {showAdvanced && (
            <View style={styles.manualInput}>
              <Text style={styles.manualTitle}>Add Device Manually</Text>
              <Text style={styles.manualHint}>
                Use this only if discovery fails. Enter an IP address on your local network.
              </Text>

              <TextInput
                style={styles.input}
                placeholder="Device Name (optional)"
                placeholderTextColor={colors.textMuted}
                value={manualName}
                onChangeText={setManualName}
              />

              <View style={styles.inputRow}>
                <TextInput
                  style={[styles.input, styles.inputHost]}
                  placeholder="IP Address (e.g., 192.168.1.100)"
                  placeholderTextColor={colors.textMuted}
                  value={manualHost}
                  onChangeText={setManualHost}
                  keyboardType={Platform.OS === 'web' ? 'default' : 'numeric'}
                  autoCapitalize="none"
                />
                <TextInput
                  style={[styles.input, styles.inputPort]}
                  placeholder="Port"
                  placeholderTextColor={colors.textMuted}
                  value={manualPort}
                  onChangeText={setManualPort}
                  keyboardType="numeric"
                />
              </View>

              <Text style={styles.manualHint}>Protocol: Chromecast</Text>

              <Pressable
                style={[styles.addButton, !manualHost.trim() && styles.addButtonDisabled]}
                onPress={handleAddManual}
                disabled={!manualHost.trim() || isAdding}
              >
                {isAdding ? (
                  <ActivityIndicator size={16} color={colors.onPrimary} />
                ) : (
                  <Text style={styles.addButtonText}>Add Device</Text>
                )}
              </Pressable>
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
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'flex-end',
  },
  modal: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.glassBorder,
    maxHeight: '80%',
    paddingBottom: 32,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    fontSize: 18,
    fontFamily: fonts.heading,
    color: colors.text,
  },
  closeButton: {
    padding: 4,
  },
  deviceList: {
    maxHeight: 300,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 48,
    gap: 16,
  },
  emptyText: {
    fontSize: 16,
    color: colors.textMuted,
    textAlign: 'center',
  },
  emptySubtext: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
    opacity: 0.7,
  },
  emptyRefresh: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyRefreshText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.primary,
  },
  deviceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 12,
  },
  deviceItemConnected: {
    backgroundColor: colors.primaryLight,
  },
  deviceIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.text,
  },
  deviceNameConnected: {
    color: colors.primary,
  },
  deviceMeta: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2,
  },
  connectedBadge: {
    backgroundColor: colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  connectedText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.onPrimary,
  },
  actions: {
    flexDirection: 'row',
    padding: 16,
    gap: 16,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    backgroundColor: colors.bg,
    borderRadius: 8,
    flex: 1,
    justifyContent: 'center',
  },
  actionText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.primary,
  },
  manualInput: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 12,
  },
  manualTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 4,
  },
  manualHint: {
    fontSize: 13,
    color: colors.textMuted,
    opacity: 0.8,
    marginBottom: 8,
  },
  input: {
    backgroundColor: colors.bg,
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 12,
  },
  inputHost: {
    flex: 3,
  },
  inputPort: {
    flex: 1,
  },
  protocolRow: {
    flexDirection: 'row',
    gap: 12,
  },
  protocolButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  protocolButtonActive: {
    borderColor: colors.primary,
    backgroundColor: 'rgba(145, 71, 255, 0.12)',
  },
  protocolText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted,
  },
  protocolTextActive: {
    color: colors.primary,
  },
  addButton: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  addButtonDisabled: {
    opacity: 0.5,
  },
  addButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.onPrimary,
  },
})

export default DevicePickerModal
