export const GIB = 1024 ** 3

const DEFAULT_ARCHIVE_CAPACITY_BYTES = 5 * GIB

/** Keep a fresh archive pledge within the device's configured storage ceiling. */
export function archiveCapacityForStorageMax(storageMaxBytes: number | null | undefined): number {
  const ceiling = Number.isFinite(storageMaxBytes) && (storageMaxBytes as number) > 0
    ? storageMaxBytes as number
    : DEFAULT_ARCHIVE_CAPACITY_BYTES

  return Math.max(1 * GIB, Math.min(ceiling, DEFAULT_ARCHIVE_CAPACITY_BYTES))
}
