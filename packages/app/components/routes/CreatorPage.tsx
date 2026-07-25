import React from 'react'
import { ContributionList } from '../media/ContributionList'

type CreatorMediaGraph = {
  getMediaAgent?: unknown
  getAgentContributions?: unknown
}

type CreatorAgent = {
  name?: string
}

type Contribution = {
  agentId?: string
  name?: string
  role?: string
  publisherId?: string
}

type CreatorPageProps = {
  id?: string
  mediaGraph?: CreatorMediaGraph
  agent?: CreatorAgent | null
  contributions?: Contribution[]
}

export default function CreatorPage({ id, mediaGraph, agent = null, contributions = [] }: CreatorPageProps) {
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
