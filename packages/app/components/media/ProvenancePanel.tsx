import React from 'react'

export function ProvenancePanel({ provenance = [] }: { provenance?: string[] }) {
  return <section>{provenance.map((entry) => <div key={entry}>{entry}</div>)}</section>
}
