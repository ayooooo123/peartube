import React from 'react'

export function FeedTrustEditor({ policy = {}, onChange = () => {} }: { policy?: any, onChange?: (patch: any) => void }) {
  return (
    <section>
      <h2>Followed publishers and indexes</h2>
      <p>Only explicitly followed publishers/indexes are synced.</p>
      <button onClick={() => onChange({ followedPublishers: policy.followedPublishers || [] })}>followedPublishers</button>
      <button onClick={() => onChange({ followedIndexes: policy.followedIndexes || [] })}>followedIndexes</button>
    </section>
  )
}
