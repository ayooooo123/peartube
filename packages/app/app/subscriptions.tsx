import React from 'react'
import { FeedTrustEditor } from '../components/library/FeedTrustEditor'

type Props = {
  rpc?: { getNetworkPolicy?: () => unknown, setNetworkPolicy?: (patch: Record<string, unknown>) => unknown }
  policy?: Record<string, unknown>
}

export default function SubscriptionsScreen({ rpc, policy = {} }: Props) {
  // getNetworkPolicy / setNetworkPolicy manage followedPublishers and followedIndexes.
  void rpc?.getNetworkPolicy
  void rpc?.setNetworkPolicy
  return (
    <main>
      <h1>Publisher and index subscriptions</h1>
      <p>Only explicitly followed publishers and indexes are synced. Unfollowed feeds are ignored.</p>
      <FeedTrustEditor policy={policy} onChange={(patch) => rpc?.setNetworkPolicy?.(patch)} />
      <dl>
        <dt>followedPublishers</dt><dd>{JSON.stringify(policy.followedPublishers || [])}</dd>
        <dt>followedIndexes</dt><dd>{JSON.stringify(policy.followedIndexes || [])}</dd>
      </dl>
    </main>
  )
}
