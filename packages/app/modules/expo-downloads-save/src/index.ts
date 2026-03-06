import { requireNativeModule, Platform } from 'expo-modules-core'

interface DownloadsSaveModule {
  saveToDownloads(
    sourceFilePath: string,
    filename: string,
    mimeType: string
  ): Promise<string>
}

const downloadsSaveFallback: DownloadsSaveModule = {
  saveToDownloads: async () => {
    throw new Error('saveToDownloads is not available on this runtime')
  }
}

let downloadsSaveCache: DownloadsSaveModule | null = null

function getDownloadsSaveModule(): DownloadsSaveModule {
  if (Platform.OS === 'web') return downloadsSaveFallback
  if (downloadsSaveCache) return downloadsSaveCache
  try {
    downloadsSaveCache = requireNativeModule<DownloadsSaveModule>('DownloadsSave')
    return downloadsSaveCache
  } catch (err) {
    console.warn('[DownloadsSave] Native module unavailable:', err)
    return downloadsSaveFallback
  }
}

/**
 * Save a file from app storage to the system Downloads folder
 *
 * @param sourceFilePath - The path to the file in app storage (from bare-fs)
 * @param filename - The desired filename in Downloads (e.g., "video.mp4")
 * @param mimeType - The MIME type of the file (e.g., "video/mp4")
 * @returns Promise<string> - The final path/URI where the file was saved
 */
export async function saveToDownloads(
  sourceFilePath: string,
  filename: string,
  mimeType: string = 'video/mp4'
): Promise<string> {
  return getDownloadsSaveModule().saveToDownloads(sourceFilePath, filename, mimeType)
}

export default {
  saveToDownloads
}
