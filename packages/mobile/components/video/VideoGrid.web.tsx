/**
 * Video Grid - Desktop responsive grid layout for videos
 *
 * Responsive columns:
 * - ≥1280px: 4 columns
 * - 992-1279px: 3 columns
 * - <992px: 2 columns
 */
import React from 'react'
import { VideoCardDesktop, VideoCardProps } from './VideoCard.web'

interface VideoGridProps {
  videos: VideoCardProps[]
  onVideoPress?: (videoId: string) => void
}

export function VideoGrid({ videos, onVideoPress }: VideoGridProps) {
  return (
    <div style={styles.container}>
      <div style={styles.grid} className="desktop-video-grid">
        {videos.map((video) => (
          <VideoCardDesktop
            key={video.id}
            {...video}
            onPress={() => onVideoPress?.(video.id)}
          />
        ))}
      </div>
      <style>{`
        .desktop-video-grid {
          display: grid;
          gap: 24px;
          grid-template-columns: repeat(2, 1fr);
        }
        @media (min-width: 992px) {
          .desktop-video-grid {
            grid-template-columns: repeat(3, 1fr);
          }
        }
        @media (min-width: 1280px) {
          .desktop-video-grid {
            grid-template-columns: repeat(4, 1fr);
          }
        }
      `}</style>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '24px',
    width: '100%',
  },
  grid: {
    width: '100%',
  },
}

export default VideoGrid
