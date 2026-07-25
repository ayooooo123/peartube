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
      <section>
        <h2>Privacy basics</h2>
        <p>
          Trust, moderation, and retention are local-only decisions. They are applied on this device and are
          never announced to the network or shared with other peers.
        </p>
        <p>By contrast, these actions are visible to peers, indexes, or anyone watching the network:</p>
        <ul>
          <li>Following publishers and indexes reveals your interest to the peers you follow.</li>
          <li>Catalog and asset requests disclose which media you are looking up and fetching.</li>
          <li>Archive challenges and pledges are signed public records tied to your key.</li>
          <li>Seeding advertises the blocks you can serve to everyone in the swarm.</li>
          <li>mDNS and local discovery broadcast your presence to devices on nearby networks.</li>
          <li>Every peer connection exposes your IP address, which observers can correlate across sessions.</li>
        </ul>
        <p>
          PearTube does not provide anonymity. This screen describes what is shared so you can choose; it makes
          no privacy promise.
        </p>
      </section>
    </main>
  )
}
