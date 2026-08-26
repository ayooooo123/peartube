import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

export type PublisherDeviceState =
  | 'authorized'
  | 'stale'
  | 'revoked'
  | 'authority-lost'
  | 'unable-to-publish'

export type PublisherCapabilityAction =
  | 'publish'
  | 'root-transition'
  | 'play-local'
  | 'export-local'
  | 'delete-local'

export type PublisherDeviceStatusInput = {
  success?: boolean | null
  status?: string | null
  reasonCode?: string | null
  canPublish?: boolean | null
  canPlayLocal?: boolean | null
  canExportLocal?: boolean | null
  canDeleteLocal?: boolean | null
  canRootTransition?: boolean | null
  publisherId?: unknown
  devicePublicKey?: unknown
}

export type PublisherDeviceStatusModel = {
  status: PublisherDeviceState
  label: string
  explanation: string
  detail: string | null
  actions: Array<{ id: PublisherCapabilityAction, label: string, allowed: boolean }>
}

const STATUS_COPY: Readonly<Record<PublisherDeviceState, { label: string, explanation: string }>> = Object.freeze({
  authorized: {
    label: 'Authorized',
    explanation: 'This device is authorized to publish and change publisher authority.',
  },
  stale: {
    label: 'Publisher data out of date',
    explanation: 'This device must refresh its publisher authorization before it can publish or change authority.',
  },
  revoked: {
    label: 'Device revoked',
    explanation: 'This device was revoked and cannot publish or change publisher authority.',
  },
  'authority-lost': {
    label: 'Publisher authority unavailable',
    explanation: 'Publisher authority is no longer available on this device.',
  },
  'unable-to-publish': {
    label: 'Unable to publish',
    explanation: 'This device cannot publish until its local publisher security issue is resolved.',
  },
})

const REASON_COPY: Readonly<Record<string, string>> = Object.freeze({
  ROOT_AUTHORITY_LOST: 'The publisher authority material is not available on this device.',
  ROOT_AUTHORITY_ROTATED: 'Publisher authority changed on another authorized device.',
  LOCAL_CATALOG_STALE: 'The local publisher catalog needs to be refreshed.',
  LOCAL_POLICY_STALE: 'The local publisher policy needs to be refreshed.',
  LOCAL_WRITER_UNAVAILABLE: 'The local publishing writer is unavailable.',
  DEVICE_NOT_ADMITTED: 'This device has not been admitted for publishing.',
  LOCAL_SIGNER_UNAVAILABLE: 'The local publisher signer is unavailable.',
  DEVICE_SIGNER_MISMATCH: 'The local signer does not match this device authorization.',
  DEVICE_REVOKED: 'This device authorization has been revoked.',
  LEGACY_IMPORT_FAILED: 'The local legacy publisher import did not complete.',
})

const VALID_STATUS: Readonly<Record<PublisherDeviceState, true>> = Object.freeze({
  authorized: true,
  stale: true,
  revoked: true,
  'authority-lost': true,
  'unable-to-publish': true,
})

export function normalizePublisherDeviceStatus(input: PublisherDeviceStatusInput | null | undefined): PublisherDeviceStatusModel {
  const requestSucceeded = input?.success === true
  const candidate = input?.status
  const knownStatus = typeof candidate === 'string' && Object.prototype.hasOwnProperty.call(VALID_STATUS, candidate)
  const status = requestSucceeded && knownStatus ? candidate as PublisherDeviceState : 'unable-to-publish'
  const privilegedStatus = requestSucceeded && knownStatus && status === 'authorized'
  const copy = requestSucceeded && knownStatus
    ? STATUS_COPY[status]
    : {
        label: 'Publisher status unavailable',
        explanation: 'Publisher security status could not be loaded on this device.',
      }
  const reasonCode = input?.reasonCode
  const detail = requestSucceeded &&
    typeof reasonCode === 'string' &&
    Object.prototype.hasOwnProperty.call(REASON_COPY, reasonCode)
    ? REASON_COPY[reasonCode]
    : null

  return {
    status,
    label: copy.label,
    explanation: copy.explanation,
    detail,
    actions: [
      { id: 'publish', label: 'Publish', allowed: privilegedStatus && input?.canPublish === true },
      { id: 'root-transition', label: 'Change publisher authority', allowed: privilegedStatus && input?.canRootTransition === true },
      { id: 'play-local', label: 'Play local media', allowed: requestSucceeded && input?.canPlayLocal === true },
      { id: 'export-local', label: 'Export local media', allowed: requestSucceeded && input?.canExportLocal === true },
      { id: 'delete-local', label: 'Delete local media', allowed: requestSucceeded && input?.canDeleteLocal === true },
    ],
  }
}

export type PublisherDeviceStatusProps = {
  status: PublisherDeviceStatusInput | null | undefined
  actionHandlers?: Partial<Record<PublisherCapabilityAction, () => void>>
}

export function PublisherDeviceStatus({ status, actionHandlers = {} }: PublisherDeviceStatusProps) {
  const model = normalizePublisherDeviceStatus(status)
  return (
    <View
      accessibilityLabel="Publisher device security"
      accessibilityLiveRegion="polite"
      style={styles.panel}
    >
      <Text style={styles.kicker}>Publisher device security</Text>
      <Text style={styles.title}>{model.label}</Text>
      <Text style={styles.explanation}>{model.explanation}</Text>
      {model.detail ? <Text style={styles.detail}>{model.detail}</Text> : null}
      <Text style={styles.detail}>Publishing restrictions do not remove local media that this device is still allowed to use.</Text>
      <View accessibilityLabel="Publisher and local-media capabilities" style={styles.actions}>
        {model.actions.map((action) => {
          const handler = actionHandlers[action.id]
          if (!handler) {
            return (
              <View
                key={action.id}
                accessibilityState={{ disabled: !action.allowed }}
                testID={`publisher-action-${action.id}`}
                style={[styles.action, !action.allowed && styles.actionDenied]}
              >
                <Text style={styles.actionText}>{action.label}: {action.allowed ? 'Allowed' : 'Not allowed'}</Text>
              </View>
            )
          }
          return (
            <Pressable
              key={action.id}
              accessibilityRole="button"
              accessibilityState={{ disabled: !action.allowed }}
              disabled={!action.allowed}
              testID={`publisher-action-${action.id}`}
              onPress={action.allowed ? handler : undefined}
              style={({ pressed }) => [
                styles.action,
                !action.allowed && styles.actionDenied,
                pressed && action.allowed && styles.actionPressed,
              ]}
            >
              <Text style={styles.actionText}>{action.label}: {action.allowed ? 'Allowed' : 'Not allowed'}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.22)',
    borderRadius: 18,
    backgroundColor: 'rgba(15,23,42,0.76)',
    padding: 16,
    gap: 8,
  },
  kicker: {
    color: '#7b5bf5',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  title: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '800',
  },
  explanation: {
    color: '#e2e8f0',
    fontSize: 14,
    lineHeight: 20,
  },
  detail: {
    color: '#94a3b8',
    fontSize: 12,
    lineHeight: 18,
  },
  actions: {
    gap: 8,
    marginTop: 4,
  },
  action: {
    borderWidth: 1,
    borderColor: 'rgba(123, 91, 245,0.30)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: 'rgba(123, 91, 245,0.08)',
  },
  actionDenied: {
    borderColor: 'rgba(148,163,184,0.20)',
    backgroundColor: 'rgba(148,163,184,0.06)',
    opacity: 0.72,
  },
  actionPressed: {
    opacity: 0.74,
  },
  actionText: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '700',
  },
})
