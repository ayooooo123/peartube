import type { ComponentType } from 'react'
import type { ArchiveOperatorStatus } from '@/lib/storage-operability.js'
import type { SeedingStatus, StorageStats, SwarmStatus } from './types'

export interface DiagnosticsPanelProps {
  swarmStatus: SwarmStatus | null
  storageStats: StorageStats | null
  seedingStatus: SeedingStatus | null
  operatorStatus: ArchiveOperatorStatus | null
  loading?: boolean
  onRefresh?: () => void
}

declare const DiagnosticsPanel: ComponentType<DiagnosticsPanelProps>
export default DiagnosticsPanel
