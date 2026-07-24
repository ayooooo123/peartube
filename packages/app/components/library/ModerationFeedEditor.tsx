import React from 'react'

export function ModerationFeedEditor({ policy = {}, onChange = () => {} }: { policy?: any, onChange?: (patch: any) => void }) {
  return (
    <section>
      <h2>Moderation feeds</h2>
      <p>Moderation feeds apply as local policy on your device; they do not control anyone else’s library.</p>
      <button onClick={() => onChange({ trustedModerationFeeds: policy.trustedModerationFeeds || [] })}>trustedModerationFeeds</button>
      <button onClick={() => onChange({ aiAnalysis: policy.aiAnalysis || 'disabled' })}>aiAnalysis</button>
    </section>
  )
}
