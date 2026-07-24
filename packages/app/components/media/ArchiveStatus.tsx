import React from 'react'

export function ArchiveStatus({ status = null }: { status?: { pledgeCount?: number } | null }) {
  const count = status?.pledgeCount || 0
  return <section>{count > 0 ? `${count} archival pledge(s) observed; retention is not guaranteed and may change.` : 'Archive state uncertain; retention is not a guarantee.'}</section>
}
