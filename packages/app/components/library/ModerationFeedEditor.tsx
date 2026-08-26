import { PolicyCard, PolicyHeading, PolicyListEditor } from './PolicyControls'

export function ModerationFeedEditor({
  subscriptions,
  disabled = false,
  onReplace,
}: {
  subscriptions: string[]
  disabled?: boolean
  onReplace(subscriptions: string[]): void
}) {
  return (
    <PolicyCard>
      <PolicyHeading
        title="Moderation feeds"
        description="Signed moderation records are local policy on your device. They do not edit publisher catalogs or control another device."
      />
      <PolicyListEditor
        label="Subscription signer IDs"
        description="Replace the active profile set with canonical 32-byte signer identifiers whose decisions you want to apply locally."
        values={subscriptions}
        placeholder="64-character signer ID"
        disabled={disabled}
        onChange={onReplace}
      />
    </PolicyCard>
  )
}
