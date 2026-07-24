import React from 'react'

export function ConflictNotice({ conflicts = [] }: { conflicts?: Array<{ field?: string }> }) {
  if (conflicts.length === 0) return null
  return <section role="status">Conflicting metadata claims need review: {conflicts.map((conflict) => conflict.field || 'unknown').join(', ')}</section>
}
