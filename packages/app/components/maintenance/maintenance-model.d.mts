export const MIGRATION_ID: 'publication-v1'
export const MAX_MIGRATION_REPORT_BYTES: number
export const MAX_PORTABLE_MANIFEST_BYTES: number
export const MAX_PORTABLE_FILE_BYTES: number

export type MigrationStatus = {
  success?: boolean
  migrationId?: string
  state?: string
  processedCount?: number
  importedCount?: number
  skippedCount?: number
  quarantinedCount?: number
  unsupportedCount?: number
  remainingCount?: number
  retryable?: boolean
  updatedAt?: number | string
  errorCode?: string | null
  errorMessage?: string | null
  reportDigest?: string | null
}

export type PortableSelection = {
  fileName: string
  schemaVersion: number
  manifestDigest: string
  manifestBytes: Uint8Array
}

export type MaintenanceRpc = {
  getMigrationStatus?: (request: { migrationId: string }) => Promise<unknown>
  retryMigration?: (request: { migrationId: string }) => Promise<unknown>
  exportMigrationReport?: (request: { migrationId: string }) => Promise<unknown>
  exportPortableState?: () => Promise<unknown>
  restorePortableState?: (request: { manifestBytes: Uint8Array; manifestDigest: string }) => Promise<unknown>
}
export type MaintenanceFiles = {
  save(file: { bytes: Uint8Array; fileName: string; mimeType: string }): Promise<unknown>
  select(options: { maxBytes: number; mimeType: string }): Promise<{ fileName: string; bytes: Uint8Array } | null>
}
export type MaintenanceCapability = { available: boolean; reason: string }
export type MaintenanceCapabilities = {
  status: MaintenanceCapability
  retry: MaintenanceCapability
  report: MaintenanceCapability
  export: MaintenanceCapability
  select: MaintenanceCapability
  restore: MaintenanceCapability
}

export function boundedError(error: unknown, fallback?: string): string
export function boundedDiagnosticCode(value: unknown, fallback?: string): string
export function maintenanceCapabilities(options?: { rpc?: MaintenanceRpc | null; files?: Partial<MaintenanceFiles> | null }): MaintenanceCapabilities
export function migrationPresentation(state: unknown): { label: string; tone: string }
export function migrationCounterRows(status: MigrationStatus | null | undefined): Array<[string, number]>
export function canRetryMigration(status: MigrationStatus | null | undefined): boolean
export function createPortableEnvelope(options: { schemaVersion: number; manifestBytes: Uint8Array; manifestDigest: string }): Uint8Array
export function parsePortableEnvelope(input: Uint8Array): Omit<PortableSelection, 'fileName'>
export function createMaintenanceActions(options: { rpc?: MaintenanceRpc | null; files?: Partial<MaintenanceFiles> | null }): {
  getMigrationStatus(): Promise<MigrationStatus>
  retryMigration(status: MigrationStatus | null): Promise<MigrationStatus>
  saveMigrationReport(): Promise<unknown>
  savePortableState(): Promise<unknown>
  selectPortableState(): Promise<PortableSelection | null>
  restorePortableState(selection: PortableSelection | null): Promise<{
    success?: boolean
    schemaVersion?: number
    importedCount?: number
    skippedCount?: number
    idempotent?: boolean
  }>
}
