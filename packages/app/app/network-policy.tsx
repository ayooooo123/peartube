import React from 'react'
import { RetentionPolicyEditor } from '../components/library/RetentionPolicyEditor'

type Props = {
  rpc?: { getNetworkPolicy?: () => unknown, setNetworkPolicy?: (patch: Record<string, unknown>) => unknown }
  policy?: Record<string, unknown>
}

export default function NetworkPolicyScreen({ rpc, policy = {} }: Props) {
  // getNetworkPolicy / setNetworkPolicy drive uploadPermission, meteredNetwork, backgroundMode, diskCeilingBytes, uploadCeilingBytes, and retentionMode.
  void rpc?.getNetworkPolicy
  void rpc?.setNetworkPolicy
  return (
    <main>
      <h1>Network policy</h1>
      <p>Sharing may expose your public IP. You cannot retract bytes peers already downloaded.</p>
      <RetentionPolicyEditor policy={policy} onChange={(patch) => rpc?.setNetworkPolicy?.(patch)} />
      <dl>
        <dt>uploadPermission</dt><dd>{String(policy.uploadPermission || 'manual')}</dd>
        <dt>meteredNetwork</dt><dd>{String(policy.meteredNetwork || 'pause-network')}</dd>
        <dt>backgroundMode</dt><dd>{String(policy.backgroundMode || 'local-only')}</dd>
        <dt>diskCeilingBytes</dt><dd>{String(policy.diskCeilingBytes || 0)}</dd>
        <dt>uploadCeilingBytes</dt><dd>{String(policy.uploadCeilingBytes || 0)}</dd>
        <dt>retentionMode</dt><dd>{String(policy.retentionMode || 'none')}</dd>
      </dl>
    </main>
  )
}
