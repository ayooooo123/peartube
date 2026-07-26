import { useRouter } from 'expo-router'
import { useApp } from '@/lib/AppContext'
import { ChoiceGroup, PolicyCard, PolicyHeading, PolicyScreenFrame } from '@/components/library/PolicyControls'
import { useNetworkPolicy } from '@/hooks/useNetworkPolicy'
import type { NetworkPolicy, NetworkPolicyRpc } from '@/lib/network-policy'
import { DeveloperModeGate } from '@/lib/developer-mode'

type Props = {
  rpc?: NetworkPolicyRpc | null
  policy?: Partial<NetworkPolicy> | null
}

function ModerationScreen({ rpc, policy }: Props) {
  if (rpc) return <ModerationContent rpc={rpc} initialPolicy={policy} />
  return <ConnectedModeration initialPolicy={policy} />
}

export default function DeveloperModerationScreen(props: Props) {
  return <DeveloperModeGate><ModerationScreen {...props} /></DeveloperModeGate>
}

function ConnectedModeration({ initialPolicy }: { initialPolicy?: Partial<NetworkPolicy> | null }) {
  const { rpc } = useApp()
  return <ModerationContent rpc={rpc} initialPolicy={initialPolicy} />
}

function ModerationContent({
  rpc,
  initialPolicy,
}: {
  rpc: NetworkPolicyRpc | null
  initialPolicy?: Partial<NetworkPolicy> | null
}) {
  const router = useRouter()
  const state = useNetworkPolicy(rpc, initialPolicy)
  return (
    <PolicyScreenFrame
      title="Moderation"
      subtitle="Local trust inputs and optional derived analysis for this device."
      loading={state.loading}
      saving={state.saving}
      error={state.error}
      onBack={() => router.back()}
      onRetry={() => { void state.reload() }}
    >
      {state.policy ? (
        <>
          <PolicyCard tone="privacy">
            <PolicyHeading
              title="Local decisions, inspectable evidence"
              description="Moderation feeds influence download, display, and seeding only on this device. Publisher-authored records remain immutable and inspectable."
            />
          </PolicyCard>
          <PolicyCard>
            <PolicyHeading
              title="Transport-only analysis policy"
              description="Active moderation subscriptions are profile-linked and replaced in Developer Settings. This editor cannot create an independent feed set."
            />
            <ChoiceGroup
              label="Optional AI analysis"
              value={state.policy.aiAnalysis}
              disabled={state.saving}
              options={[
                { value: 'disabled', label: 'Disabled', detail: 'Do not run automated media analysis.' },
                { value: 'local-only', label: 'Local only', detail: 'Keep derived annotations on this device.' },
                { value: 'enabled', label: 'Share enabled', detail: 'Allow configured analysis outputs to be published as non-canonical annotations.' },
              ]}
              onChange={(aiAnalysis) => { void state.update({ aiAnalysis }) }}
            />
          </PolicyCard>
        </>
      ) : null}
    </PolicyScreenFrame>
  )
}
