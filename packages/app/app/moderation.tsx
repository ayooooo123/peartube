import React from 'react'
import { ModerationFeedEditor } from '../components/library/ModerationFeedEditor'

type Props = {
  rpc?: { getNetworkPolicy?: () => unknown, setNetworkPolicy?: (patch: Record<string, unknown>) => unknown }
  policy?: Record<string, unknown>
}

export default function ModerationScreen({ rpc, policy = {} }: Props) {
  // getNetworkPolicy / setNetworkPolicy manage trustedModerationFeeds and aiAnalysis.
  void rpc?.getNetworkPolicy
  void rpc?.setNetworkPolicy
  return (
    <main>
      <h1>Moderation and AI analysis</h1>
      <p>Trusted moderation feeds are local policy for your device. Optional AI analysis stores derived annotations, not canonical media edits.</p>
      <ModerationFeedEditor policy={policy} onChange={(patch) => rpc?.setNetworkPolicy?.(patch)} />
      <dl>
        <dt>trustedModerationFeeds</dt><dd>{JSON.stringify(policy.trustedModerationFeeds || [])}</dd>
        <dt>aiAnalysis</dt><dd>{String(policy.aiAnalysis || 'disabled')}</dd>
      </dl>
    </main>
  )
}
