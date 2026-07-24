import React from 'react'

export function RetentionPolicyEditor({ policy = {}, onChange = () => {} }: { policy?: any, onChange?: (patch: any) => void }) {
  return (
    <section>
      <h2>Retention</h2>
      <p>Archive pledges are evidence only; long-term retention is not a guarantee.</p>
      <button onClick={() => onChange({ retentionMode: 'archive-pledges' })}>{policy.retentionMode || 'none'}</button>
    </section>
  )
}
