import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'

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
function resolveDeviceStateAndCopy(
  requestSucceeded: boolean,
  candidate?: string | null
): { status: PublisherDeviceState; copy: { label: string; explanation: string }; isPrivileged: boolean } {
  const isKnown = typeof candidate === 'string' && Object.prototype.hasOwnProperty.call(VALID_STATUS, candidate)
  if (requestSucceeded && isKnown) {
    const status = candidate as PublisherDeviceState
    return {
      status,
      copy: STATUS_COPY[status],
      isPrivileged: status === 'authorized',
    }
  }
  return {
    status: 'unable-to-publish',
    copy: {
      label: 'Publisher status unavailable',
      explanation: 'Publisher security status could not be loaded on this device.',
    },
    isPrivileged: false,
  }
}

function resolveReasonDetail(requestSucceeded: boolean, reasonCode?: string | null): string | null {
  if (
    requestSucceeded &&
    typeof reasonCode === 'string' &&
    Object.prototype.hasOwnProperty.call(REASON_COPY, reasonCode)
  ) {
    return REASON_COPY[reasonCode]
  }
  return null
}

function buildDeviceStatusActions(
  requestSucceeded: boolean,
  privilegedStatus: boolean,
  input: PublisherDeviceStatusInput | null | undefined
): PublisherDeviceStatusModel['actions'] {
  return [
    { id: 'publish', label: 'Publish', allowed: privilegedStatus && input?.canPublish === true },
    { id: 'root-transition', label: 'Change publisher authority', allowed: privilegedStatus && input?.canRootTransition === true },
    { id: 'play-local', label: 'Play local media', allowed: requestSucceeded && input?.canPlayLocal === true },
    { id: 'export-local', label: 'Export local media', allowed: requestSucceeded && input?.canExportLocal === true },
    { id: 'delete-local', label: 'Delete local media', allowed: requestSucceeded && input?.canDeleteLocal === true },
  ]
}

const STATUS_TAG: Readonly<Record<PublisherDeviceState, { label: string, tone: 'success' | 'warning' | 'danger' }>> = Object.freeze({
  authorized: { label: 'PAIRED', tone: 'success' },
  stale: { label: 'STALE', tone: 'warning' },
  revoked: { label: 'REVOKED', tone: 'danger' },
  'authority-lost': { label: 'LOCKED', tone: 'danger' },
  'unable-to-publish': { label: 'BLOCKED', tone: 'danger' },
})

const TAG_TONE_COLOR = {
  success: colors.success,
  warning: colors.warning,
  danger: colors.error,
} as const

export function normalizePublisherDeviceStatus(input: PublisherDeviceStatusInput | null | undefined): PublisherDeviceStatusModel {
  const requestSucceeded = input?.success === true
  const { status, copy, isPrivileged } = resolveDeviceStateAndCopy(requestSucceeded, input?.status)
  const detail = resolveReasonDetail(requestSucceeded, input?.reasonCode)
  const actions = buildDeviceStatusActions(requestSucceeded, isPrivileged, input)

  return {
    status,
    label: copy.label,
    explanation: copy.explanation,
    detail,
    actions,
  }
}

export type PublisherDeviceStatusProps = {
  status: PublisherDeviceStatusInput | null | undefined
  actionHandlers?: Partial<Record<PublisherCapabilityAction, () => void>>
}

export function PublisherDeviceStatus({ status, actionHandlers = {} }: PublisherDeviceStatusProps) {
  const model = normalizePublisherDeviceStatus(status)
  const tag = STATUS_TAG[model.status]
  const tagColor = TAG_TONE_COLOR[tag.tone]
  const titleTone = model.status === 'authorized'
    ? colors.primary
    : model.status === 'stale'
      ? colors.warning
      : colors.error
  const panelBorder = model.status === 'authorized'
    ? colors.primary
    : model.status === 'stale'
      ? colors.border
      : colors.error

  return (
    <View
      accessibilityLabel="Publisher device security"
      accessibilityLiveRegion="polite"
      style={[styles.panel, { borderColor: panelBorder }]}
    >
      <Text style={styles.kicker}>Publisher device security</Text>
      <View style={styles.titleRow}>
        <Text style={[styles.title, { color: titleTone }]}>{model.label}</Text>
        <View style={[styles.tag, { borderColor: tagColor }]}>
          <Text style={[styles.tagLabel, { color: tagColor }]}>{tag.label}</Text>
        </View>
      </View>
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
    backgroundColor: colors.surface,
    borderWidth: borderWidth.rule,
    borderRadius: radius.card,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  kicker: {
    ...fonts.caption.sm,
    color: colors.textMuted,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  title: {
    ...fonts.title.md,
    textTransform: 'uppercase',
  },
  tag: {
    borderWidth: borderWidth.hairline,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm - 2,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagLabel: {
    ...fonts.caption.sm,
    fontSize: 10,
    lineHeight: 12,
  },
  explanation: {
    ...fonts.body.sm,
    color: colors.textSecondary,
  },
  detail: {
    ...fonts.meta.sm,
    color: colors.textMuted,
  },
  actions: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  action: {
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    borderRadius: radius.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.surfaceHover,
  },
  actionDenied: {
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bg,
    opacity: 0.72,
  },
  actionPressed: {
    opacity: 0.74,
  },
  actionText: {
    ...fonts.meta.sm,
    color: colors.text,
    fontFamily: fonts.monoMedium,
  },
})
