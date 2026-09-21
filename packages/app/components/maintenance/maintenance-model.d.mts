export const MAX_PORTABLE_MANIFEST_BYTES: number
export const MAX_PORTABLE_FILE_BYTES: number

export type PortableSelection = {
  fileName: string
  schemaVersion: number
  manifestDigest: string
  manifestBytes: Uint8Array
}

export type MaintenanceRpc = {
  exportPortableState?: () => Promise<unknown>
  restorePortableState?: (request: { manifestBytes: Uint8Array; manifestDigest: string }) => Promise<unknown>
}
export type MaintenanceFiles = {
  save(file: { bytes: Uint8Array; fileName: string; mimeType: string }): Promise<unknown>
  select(options: { maxBytes: number; mimeType: string }): Promise<{ fileName: string; bytes: Uint8Array } | null>
}
export type MaintenanceCapability = { available: boolean; reason: string }
export type MaintenanceCapabilities = {
  export: MaintenanceCapability
  select: MaintenanceCapability
  restore: MaintenanceCapability
}

export function boundedError(error: unknown, fallback?: string): string
export function maintenanceCapabilities(options?: { rpc?: MaintenanceRpc | null; files?: Partial<MaintenanceFiles> | null }): MaintenanceCapabilities
export function createPortableEnvelope(options: { schemaVersion: number; manifestBytes: Uint8Array; manifestDigest: string }): Uint8Array
export function parsePortableEnvelope(input: Uint8Array): Omit<PortableSelection, 'fileName'>
export function createMaintenanceActions(options: { rpc?: MaintenanceRpc | null; files?: Partial<MaintenanceFiles> | null }): {
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
