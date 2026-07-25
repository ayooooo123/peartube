export const MAX_RENDERED_DIAGNOSTIC_ITEMS: number

export interface StorageCategoryStats {
  ownedOriginalBytes?: number | null
  immutablePublicationBytes?: number | null
  pledgedArchiveBytes?: number | null
  localCacheBytes?: number | null
  thumbnailBytes?: number | null
  indexBytes?: number | null
  temporaryTransferBytes?: number | null
  protectedBytes?: number | null
  evictableBytes?: number | null
}

export interface StorageCategoryRow {
  key: string
  label: string
  bytes: number
  formattedBytes: string
  protection: 'protected' | 'evictable'
  detail: string
}

export interface StorageLimitPreview {
  success: boolean
  requestedMaxBytes?: number
  currentUsedBytes?: number
  requiredEvictionBytes: number
  evictableBytes: number
  protectedBytes: number
  affectedSeedCount: number
  affectedCategories: string[]
  consequences: string[]
  feasible: boolean
  errorCode?: string | null
}

export interface StoragePreviewView {
  feasible: boolean
  summary: string
  protectedCopy: string
  affectedSeedCopy: string
  consequences: string[]
  affectedCategories: string[]
  hiddenConsequenceCount: number
  hiddenCategoryCount: number
}

export interface ArchiveOperatorStatus {
  success?: boolean
  operatorMode?: string
  activePledgeCount?: number
  healthyPledgeCount?: number
  failedPledgeCount?: number
  challengeSuccessCount?: number
  challengeFailureCount?: number
  capacityTotalBytes?: number | null
  capacityReservedBytes?: number | null
  capacityAvailableBytes?: number | null
  capacityRejectionCount?: number
  offloadRejectionCount?: number
  recentFailureCodes?: string[]
  updatedAt?: number
  errorCode?: string | null
}

export interface ArchiveOperatorView {
  mode: string
  modeLabel: string
  trustCopy: string
  pledgeHealth: 'degraded' | 'healthy' | 'idle'
  pledgeCopy: string
  challengeCopy: string
  capacityCopy: string
  offloadCopy: string
  failureCodes: string[]
  hiddenFailureCount: number
}

export function formatStorageBytes(value?: number | null): string
export function buildStorageCategoryRows(stats?: StorageCategoryStats | null): StorageCategoryRow[]
export function buildStoragePreviewView(preview?: StorageLimitPreview | null): StoragePreviewView | null
export function buildStorageLimitConfirmationCopy(previewView?: StoragePreviewView | null): string
export function getStorageLimitDecision(input: {
  currentMaxBytes: number
  requestedMaxBytes: number
  preview?: StorageLimitPreview | null
  confirmed?: boolean
}): { action: 'preview' | 'confirm' | 'blocked' | 'apply' }
export function runStorageLimitChange(input: {
  currentMaxBytes: number
  requestedMaxBytes: number
  previewStorageLimit: (request: { maxBytes: number }) => Promise<StorageLimitPreview>
  confirm: (previewView: StoragePreviewView) => Promise<boolean>
  apply: () => Promise<void>
}): Promise<{
  status: 'applied' | 'cancelled' | 'blocked'
  preview: StorageLimitPreview | null
  previewView: StoragePreviewView | null
}>
export function buildArchiveOperatorView(status?: ArchiveOperatorStatus | null): ArchiveOperatorView
