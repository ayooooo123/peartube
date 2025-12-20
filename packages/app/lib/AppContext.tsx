import { createContext, useContext } from 'react'
import type { Identity, Video } from '@peartube/core'

export interface AppContextType {
  ready: boolean
  identity: Identity | null
  videos: Video[]
  loading: boolean
  blobServerPort: number | null
  rpc: any
  platformEvents?: any
  backendError?: string | null
  retryBackend?: () => void
  uploadVideo: (
    filePath: string,
    title: string,
    description: string,
    mimeType?: string,
    category?: string,
    onProgress?: (progress: number, speed?: number, eta?: number, isTranscoding?: boolean) => void,
    skipThumbnailGeneration?: boolean
  ) => Promise<any>
  pickVideoFile: () => Promise<{ filePath: string; name: string; size: number } | { cancelled: true } | null>
  pickImageFile: () => Promise<{ filePath: string; name: string; size: number } | { cancelled: true } | null>
  loadIdentity: () => Promise<void>
  createIdentity: (name: string) => Promise<Identity>
  loadVideos: (driveKey: string) => Promise<void>
}

export const AppContext = createContext<AppContextType | null>(null)

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}


