import type { ComponentProps } from 'react'
import React from 'react'
import { useApp } from '@/lib/AppContext'
import { useOptionalVideoPlayerActions } from '@/lib/VideoPlayerContext'
import MediaEntityPage, { normalizeMediaEntityView } from '../../components/routes/MediaEntityPage'
import type { MediaEntityView } from '../../components/routes/MediaEntityPage'

export { normalizeMediaEntityView }
export type { MediaEntityView }

export default function MediaWebRoute(props: ComponentProps<typeof MediaEntityPage>) {
  const { rpc } = useApp()
  const playerActions = useOptionalVideoPlayerActions()
  // Same wiring as the native route: preparation returns a URL that serves the
  // rendition, and the desktop shell needs a listener for it just as much.
  const onPlaybackPrepared = React.useCallback((prepared: {
    entityId: string
    publicationId: string | null
    renditionId: string | null
    url: string | null
    title: string
  }) => {
    if (!prepared.url || !playerActions) return
    playerActions.loadAndPlayVideo({
      id: prepared.entityId,
      title: prepared.title,
      publicationId: prepared.publicationId,
      renditionId: prepared.renditionId,
    } as any, prepared.url)
  }, [playerActions])

  return (
    <MediaEntityPage
      {...props}
      mediaGraph={props.mediaGraph || rpc}
      onPlaybackPrepared={props.onPlaybackPrepared || onPlaybackPrepared}
    />
  )
}
