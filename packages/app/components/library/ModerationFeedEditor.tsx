import { ChoiceGroup, PolicyCard, PolicyHeading, PolicyListEditor } from './PolicyControls'
import type { NetworkPolicy, NetworkPolicyPatch } from '@/lib/network-policy'

export function ModerationFeedEditor({
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
        title="Moderation feeds"
        description="Signed moderation records are local policy on your device. They do not edit publisher catalogs or control another device."
      />
      <PolicyListEditor
        label="Trusted moderation feeds"
        description="Add only feed identifiers whose publisher, publication, work, creator, or rendition decisions you want to apply locally."
        values={policy.trustedModerationFeeds}
        placeholder="Moderation feed identifier"
        disabled={disabled}
        onChange={(trustedModerationFeeds) => onChange({ trustedModerationFeeds })}
      />
      <ChoiceGroup
        label="Optional AI analysis"
        value={policy.aiAnalysis}
        disabled={disabled}
        options={[
          { value: 'disabled', label: 'Disabled', detail: 'Do not run automated media analysis.' },
          { value: 'local-only', label: 'Local only', detail: 'Keep derived annotations on this device.' },
          { value: 'enabled', label: 'Share enabled', detail: 'Allow configured analysis outputs to be published as non-canonical annotations.' },
        ]}
        onChange={(aiAnalysis) => onChange({ aiAnalysis })}
      />
    </PolicyCard>
  )
}
