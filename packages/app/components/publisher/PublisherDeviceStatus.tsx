import React from 'react'

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
    <section aria-labelledby="publisher-device-status-heading" aria-live="polite">
      <h2 id="publisher-device-status-heading">Publisher device security</h2>
      <h3>{model.label}</h3>
      <p>{model.explanation}</p>
      {model.detail ? <p>{model.detail}</p> : null}
      <p>Publishing restrictions do not remove local media that this device is still allowed to use.</p>
      <div aria-label="Publisher and local-media capabilities">
        {model.actions.map((action) => {
          const handler = actionHandlers[action.id]
          if (!handler) {
            return (
              <span key={action.id} data-action={action.id} aria-disabled={!action.allowed}>
                {action.label}: {action.allowed ? 'Allowed' : 'Not allowed'}
              </span>
            )
          }
          return (
            <button
              key={action.id}
              type="button"
              data-action={action.id}
              disabled={!action.allowed}
              onClick={action.allowed ? handler : undefined}
            >
              {action.label}: {action.allowed ? 'Allowed' : 'Not allowed'}
            </button>
          )
        })}
      </div>
    </section>
  )
}
