import { Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useApp } from '@/lib/AppContext'
import { useNetworkPolicy } from '@/hooks/useNetworkPolicy'
import {
  ChoiceGroup,
  PolicyCard,
  PolicyHeading,
  PolicyScreenFrame,
} from '@/components/library/PolicyControls'
import { RetentionPolicyEditor } from '@/components/library/RetentionPolicyEditor'
import { PARTICIPATION_MODE_LABELS, type NetworkPolicy, type NetworkPolicyRpc } from '@/lib/network-policy'
import { DeveloperModeGate } from '@/lib/developer-mode'

const UPLOAD_OPTIONS = [
  { value: 'disabled', label: 'Do not upload', detail: 'This device will not serve media blocks to peers.' },
  { value: 'manual', label: 'Ask first', detail: 'Upload only after an explicit local action.' },
  { value: 'enabled', label: 'Allow uploads', detail: 'Serve eligible blocks within the configured ceilings.' },
] as const

const NETWORK_OPTIONS = [
  { value: 'pause-network', label: 'Pause network', detail: 'Stop discovery, downloads, and uploads.' },
  { value: 'local-only', label: 'Local only', detail: 'Keep local playback available without P2P transfer.' },
  { value: 'allow', label: 'Allow P2P', detail: 'Permit discovery and transfer under the remaining policy.' },
] as const

type Props = {
  rpc?: NetworkPolicyRpc | null
  policy?: Partial<NetworkPolicy> | null
}

function NetworkPolicyScreen({ rpc, policy }: Props) {
  if (rpc) return <NetworkPolicyContent rpc={rpc} initialPolicy={policy} />
  return <ConnectedNetworkPolicy initialPolicy={policy} />
}

export default function DeveloperNetworkPolicyScreen(props: Props) {
  return <DeveloperModeGate><NetworkPolicyScreen {...props} /></DeveloperModeGate>
}

function ConnectedNetworkPolicy({ initialPolicy }: { initialPolicy?: Partial<NetworkPolicy> | null }) {
  const { rpc } = useApp()
  return <NetworkPolicyContent rpc={rpc} initialPolicy={initialPolicy} />
}

function NetworkPolicyContent({
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
      title="Network policy"
      subtitle="Exact overrides for this device. The everyday Data Saver / Balanced / Help More choice lives in Profile."
      loading={state.loading}
      saving={state.saving}
      error={state.error}
      onBack={() => router.back()}
      onRetry={() => { void state.reload() }}
    >
      {state.policy ? (
        <>
          <PolicyCard tone="warning">
            <PolicyHeading
              title="P2P traffic is observable"
              description="Sharing may expose your public IP. You cannot retract bytes peers already downloaded."
            />
          </PolicyCard>
          <PolicyCard>
            <PolicyHeading
              title={`Participation mode: ${PARTICIPATION_MODE_LABELS[state.policy.participationMode]}`}
              description="Chosen in Profile › How you help. The mode supplies this device's default ceilings. A ceiling counts as chosen once its value differs from the current mode's preset, and it then stays put: Help More will not widen it and Data Saver will not shrink it. Set it back to the mode's own value and it follows the mode again. Saving this form without changing a ceiling freezes nothing. The mode never relaxes an operating-system or hard device limit, and it never creates an archive pledge."
            />
          </PolicyCard>
          <PolicyCard>
            <PolicyHeading
              title="Transfer behavior"
              description="These controls are enforced locally before this device joins scopes or serves blocks."
            />
            <ChoiceGroup
              label="Upload permission"
              value={state.policy.uploadPermission}
              options={UPLOAD_OPTIONS}
              disabled={state.saving}
              onChange={(uploadPermission) => { void state.update({ uploadPermission }) }}
            />
            <ChoiceGroup
              label="Metered network"
              value={state.policy.meteredNetwork}
              options={NETWORK_OPTIONS}
              disabled={state.saving}
              onChange={(meteredNetwork) => { void state.update({ meteredNetwork }) }}
            />
            <ChoiceGroup
              label="Background mode"
              value={state.policy.backgroundMode}
              options={NETWORK_OPTIONS}
              disabled={state.saving}
              onChange={(backgroundMode) => { void state.update({ backgroundMode }) }}
            />
          </PolicyCard>
          <RetentionPolicyEditor
            policy={state.policy}
            disabled={state.saving}
            onChange={(patch) => { void state.update(patch) }}
          />
          <PolicyCard tone="privacy">
            <PolicyHeading
              title="Privacy basics"
              description="Trust, moderation, and retention are local-only decisions on this device. They are not announced as global truth."
            />
            <View style={{ gap: 7 }}>
              <Text style={{ color: '#d0d6e0', lineHeight: 20 }}>
                • Following publishers and indexes reveals your interests to peers in those namespaces.
              </Text>
              <Text style={{ color: '#d0d6e0', lineHeight: 20 }}>
                • Catalog and asset requests disclose what this device is looking up.
              </Text>
              <Text style={{ color: '#d0d6e0', lineHeight: 20 }}>
                • Archive challenges and pledges are signed, network-visible custody records.
              </Text>
              <Text style={{ color: '#d0d6e0', lineHeight: 20 }}>
                • Seeding advertises which blocks this device can serve.
              </Text>
              <Text style={{ color: '#d0d6e0', lineHeight: 20 }}>
                • mDNS local discovery broadcasts presence to nearby devices.
              </Text>
              <Text style={{ color: '#d0d6e0', lineHeight: 20 }}>
                • Every peer connection exposes an IP address that observers may correlate over time.
              </Text>
            </View>
            <Text style={{ color: '#d6a243', lineHeight: 20 }}>
              PearTube does not provide anonymity. These controls limit this device; they do not make a privacy promise.
            </Text>
          </PolicyCard>
        </>
      ) : null}
    </PolicyScreenFrame>
  )
}
