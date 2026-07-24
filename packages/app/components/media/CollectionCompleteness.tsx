import React from 'react'

export function CollectionCompleteness({ completeness = 'unknown', missingCount = 0 }: { completeness?: string, missingCount?: number }) {
  return <section>{completeness === 'partial' ? `${missingCount} missing placeholder item(s)` : completeness}</section>
}
