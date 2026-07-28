import type { ComponentProps } from 'react'
import React from 'react'
import { useApp } from '@/lib/AppContext'
import { useOptionalVideoPlayerActions } from '@/lib/VideoPlayerContext'
import MediaEntityPage, { normalizeMediaEntityView } from '../../components/routes/MediaEntityPage'
import type { MediaEntityView } from '../../components/routes/MediaEntityPage'

export { normalizeMediaEntityView }
export type { MediaEntityView }

export default function MediaRoute(props: ComponentProps<typeof MediaEntityPage>) {
  const { rpc } = useApp()
  const playerActions = useOptionalVideoPlayerActions()
  // Preparation picked a source and a URL that serves it; nothing was listening,
  // so Play resolved a stream and dropped it. Hand it to the same shared player
  // every other surface uses.
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
