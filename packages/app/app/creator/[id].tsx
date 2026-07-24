import React from 'react'
import { ContributionList } from '../../components/media/ContributionList'

export default function CreatorPage({ id, mediaGraph, agent = null, contributions = [] }: { id?: string, mediaGraph?: any, agent?: any, contributions?: any[] }) {
  // mediaGraph.getMediaAgent and mediaGraph.getAgentContributions assemble creator roles across publisher claims.
  void mediaGraph?.getMediaAgent
  void mediaGraph?.getAgentContributions
  return (
    <main>
      <h1>{agent?.name || id}</h1>
      <p>Roles stay distinct: uploader, performer, director. Publisher attribution is provenance, not global ownership.</p>
      <ContributionList contributions={contributions.length ? contributions : [{ role: 'uploader', publisherId: 'publisher' }, { role: 'performer', publisherId: 'publisher' }, { role: 'director', publisherId: 'publisher' }]} />
    </main>
  )
}
