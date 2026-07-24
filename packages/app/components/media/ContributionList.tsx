import React from 'react'

export function ContributionList({ contributions = [] }: { contributions?: Array<{ agentId?: string, name?: string, role?: string, publisherId?: string }> }) {
  return <section>{contributions.map((item, index) => <div key={item.agentId || index}>{item.name || item.agentId}: {item.role || 'contributor'} via publisher {item.publisherId || 'unknown'}</div>)}</section>
}
