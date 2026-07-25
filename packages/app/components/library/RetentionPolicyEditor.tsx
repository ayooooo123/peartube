import { ByteLimitEditor, ChoiceGroup, PolicyCard, PolicyHeading } from './PolicyControls'
import type { NetworkPolicy, NetworkPolicyPatch } from '@/lib/network-policy'

export function RetentionPolicyEditor({
  policy,
  disabled = false,
  onChange,
}: {
  policy: NetworkPolicy
  disabled?: boolean
  onChange(patch: NetworkPolicyPatch): void
}) {
  return (
    <PolicyCard>
      <PolicyHeading
        title="Storage and retention"
        description="Set hard local ceilings and decide whether this device keeps media beyond active playback."
      />
      <ByteLimitEditor
        label="Disk ceiling"
        detail="Maximum space PearTube may use for protected data and evictable cache on this device."
        value={policy.diskCeilingBytes}
        zeroLabel="No local storage"
        disabled={disabled}
        onChange={(diskCeilingBytes) => onChange({ diskCeilingBytes })}
      />
      <ByteLimitEditor
        label="Upload ceiling"
        detail="Maximum bytes this device may upload per policy period. Zero means no configured byte ceiling."
        value={policy.uploadCeilingBytes}
        zeroLabel="No configured ceiling"
        disabled={disabled}
        onChange={(uploadCeilingBytes) => onChange({ uploadCeilingBytes })}
      />
      <ChoiceGroup
        label="Retention mode"
        value={policy.retentionMode}
        disabled={disabled}
        options={[
          { value: 'none', label: 'Playback cache only', detail: 'Evict media when local cache policy needs space.' },
          { value: 'local-pin', label: 'Local pins', detail: 'Retain media explicitly pinned on this device.' },
          { value: 'archive-pledges', label: 'Archive participation', detail: 'Reserve exact pledged ranges and answer possession challenges.' },
        ]}
        onChange={(retentionMode) => onChange({ retentionMode })}
      />
      <PolicyHeading
        title="Retention is evidence, not permanence"
        description="Archive pledges and successful challenges show recent custody. They are not a guarantee that a peer will remain online or retain bytes forever."
      />
    </PolicyCard>
  )
}
