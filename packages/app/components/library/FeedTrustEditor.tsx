import { PolicyCard, PolicyHeading, PolicyListEditor } from './PolicyControls'
import type { NetworkPolicy, NetworkPolicyPatch } from '@/lib/network-policy'

export function FeedTrustEditor({
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
        title="Followed publishers and indexes"
        description="Only explicitly followed public namespaces are synchronized. Each choice is local to this device."
      />
      <PolicyListEditor
        label="Publishers"
        description="Add a publisher identifier whose signed catalog you want this device to discover."
        values={policy.followedPublishers}
        placeholder="Publisher identifier"
        disabled={disabled}
        onChange={(followedPublishers) => onChange({ followedPublishers })}
      />
      <PolicyListEditor
        label="Indexes"
        description="Add an index identifier whose signed introductions you want this device to inspect."
        values={policy.followedIndexes}
        placeholder="Index identifier"
        disabled={disabled}
        onChange={(followedIndexes) => onChange({ followedIndexes })}
      />
    </PolicyCard>
  )
}
