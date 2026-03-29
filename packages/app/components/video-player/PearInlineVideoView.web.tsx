import { memo } from 'react'

type PearInlineVideoViewProps = Record<string, unknown>

export function getPearInlinePlayerId(playbackSession: number, currentVideoKey?: string) {
  return `pear-inline-${playbackSession}-${currentVideoKey || 'video'}`
}

export const PearInlineVideoView = memo(function PearInlineVideoView(_props: PearInlineVideoViewProps) {
  return null
})
