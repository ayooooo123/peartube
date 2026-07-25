import { useRouter } from 'expo-router'
import { useApp } from '@/lib/AppContext'
import { FeedTrustEditor } from '@/components/library/FeedTrustEditor'
import { PolicyCard, PolicyHeading, PolicyScreenFrame } from '@/components/library/PolicyControls'
import { useNetworkPolicy } from '@/hooks/useNetworkPolicy'
import type { NetworkPolicy, NetworkPolicyRpc } from '@/lib/network-policy'

type Props = {
  rpc?: NetworkPolicyRpc | null
  policy?: Partial<NetworkPolicy> | null
}

export default function SubscriptionsScreen({ rpc, policy }: Props) {
  if (rpc) return <SubscriptionsContent rpc={rpc} initialPolicy={policy} />
  return <ConnectedSubscriptions initialPolicy={policy} />
}

function ConnectedSubscriptions({ initialPolicy }: { initialPolicy?: Partial<NetworkPolicy> | null }) {
  const { rpc } = useApp()
  return <SubscriptionsContent rpc={rpc} initialPolicy={initialPolicy} />
}

function SubscriptionsContent({
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
      title="Subscriptions"
      subtitle="Choose the publisher catalogs and signed indexes this device is allowed to synchronize."
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
              title="No universal catalog"
              description="Only explicitly followed publishers and indexes are synced. Unfollowed namespaces remain outside this device's discovery scopes."
            />
          </PolicyCard>
          <FeedTrustEditor
            policy={state.policy}
            disabled={state.saving}
            onChange={(patch) => { void state.update(patch) }}
          />
        </>
      ) : null}
    </PolicyScreenFrame>
  )
}
