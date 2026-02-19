import { useMemo } from 'react'
import { useDownloads } from '@/lib/DownloadsContext'

export function useCurrentDownloadStatus(
  videoId: string | null | undefined,
  channelKey?: string | null
) {
  const { downloads } = useDownloads()

  return useMemo(() => {
    if (!videoId) return null
    const match = downloads.find((d) => {
      if (d.videoId !== videoId) return false
      if (!channelKey) return true
      return d.channelKey === channelKey
    })
    return match?.status ?? null
  }, [downloads, videoId, channelKey])
}
