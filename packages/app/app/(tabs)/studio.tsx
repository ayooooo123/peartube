/**
 * Studio Tab - Upload and manage videos
 */
import { useRef, useState, useCallback, useEffect, type Dispatch, type SetStateAction, type ReactNode } from 'react'
import {
  View,
  Text,
  FlatList,
  Alert,
  Pressable,
  Share,
  TextInput,
  ActivityIndicator,
  Platform,
  Image,
  AppState,
  InteractionManager,
  StyleSheet,
  type StyleProp,
  type TextStyle,
  type TextInputProps,
} from 'react-native'
import { ABSOLUTE_FILL } from '@/lib/absolute-fill'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather, Ionicons } from '@expo/vector-icons'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import * as VideoThumbnails from 'expo-video-thumbnails'
import * as Clipboard from 'expo-clipboard'
import { useApp } from '../_layout'
import { colors, spacing, radius, borderWidth } from '@/lib/colors'
import { CastHeaderButton } from '@/components/cast'
import { useVideoPlayerActions } from '@/lib/VideoPlayerContext'
import { VideoEditModal } from '@/components/VideoEditModal'
import { formatBytes } from '@/lib/formatters'
import { useTabBarMetrics } from '@/lib/tabBarHeight'
import {
  Body,
  Button,
  Chip,
  EmptyState,
  Eyebrow,
  IconButton,
  Meta,
  Panel,
  ScreenHeader,
  SectionHeader,
  Tag,
} from '@/components/primitives'
import { fonts } from '@/lib/typography'
import * as haptics from '@/lib/haptics'
import { makeVideoUrlCacheKey, setCachedVideoUrl } from '@/lib/video-url-cache'
import type { Video } from '@peartube/core'
import { DeveloperModeGate } from '@/lib/developer-mode'
import {
  type StudioEpisodeMediaInput,
  uploadStudioVideo,
} from '@/lib/studio-upload-controller'
// Detect Pear desktop (must match index.web.tsx detection)
const isPear = Platform.OS === 'web' && typeof window !== 'undefined' && (!!(window as any).Pear || !!(window as any).bridge)

type StudioOffloadInfo = {
  eligible: boolean
  byteLength: number
  publicationId?: string
  assessmentId?: string
  evidenceDigest?: string
  confirmationNonce?: string
  policyVersion?: number
  limitations?: string[]
  offloaded?: boolean
  busy?: boolean
}

type StudioPickerFileResult =
  | { filePath: string; name: string; size: number; dataUrl?: string }
  | { cancelled: true }
  | null

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleDateString()
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function shortenKey(key: string | null | undefined): string {
  if (!key) return '—'
  const clean = key.replace(/[^a-fA-F0-9]/g, '')
  if (clean.length <= 12) return clean.toLowerCase() || key
  return `${clean.slice(0, 6).toLowerCase()}…${clean.slice(-4).toLowerCase()}`
}

function formatPublisherDeviceState(identity: { driveKey?: string | null; name?: string | null } | null | undefined): string {
  if (!identity) return 'NO CHANNEL'
  if (!identity.driveKey) return 'NO KEY'
  return 'READY'
}

function publisherSignerFact(identity: { driveKey?: string | null } | null | undefined): string {
  if (!identity?.driveKey) return 'NONE'
  return shortenKey(identity.driveKey)
}

function publisherCustodyFact(identity: { driveKey?: string | null } | null | undefined): string {
  if (!identity?.driveKey) return 'UNBOUND'
  return 'DEVICE-LOCAL'
}

function publisherPairingFact(
  devices: Array<{ keyHex?: string; deviceName?: string }>,
  loading: boolean,
): string {
  if (loading) return 'LOOKING…'
  if (!devices.length) return 'THIS DEVICE ONLY'
  return `${devices.length} LINKED`
}

function normalizeFsModule(mod: any): any {
  return mod?.default ?? mod
}

// expo-file-system: prefer the legacy API (stable copyAsync/deleteAsync/cacheDirectory),
// fall back to the new module if legacy is unavailable.
async function getFileSystem(): Promise<any | null> {
  if (Platform.OS === 'web') return null
  try {
    return normalizeFsModule(await import('expo-file-system/legacy'))
  } catch {
    try {
      return normalizeFsModule(await import('expo-file-system'))
    } catch {
      return null
    }
  }
}

// Copy an Android SAF content:// (or file://) URI into the app cache and return a
// real file:// path. The P2P backend streams the upload off a filesystem path
// (bare-fs can't read content:// URIs), so we must materialize a local copy. We do
// this ourselves — with visible UI feedback — instead of letting the document
// picker copy inline (copyToCacheDirectory), which blocks with no feedback and is
// unreliable/slow for large (1GB+) files.
async function copyPickedVideoToCache(srcUri: string, name?: string): Promise<string> {
  const fs = await getFileSystem()
  const cacheDir: string | undefined = fs?.cacheDirectory || fs?.Paths?.cache?.uri
  if (!fs || typeof fs.copyAsync !== 'function' || !cacheDir) {
    throw new Error('File system unavailable')
  }
  const rawExt = (name?.split('.').pop() || srcUri.split('.').pop() || 'mp4')
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5) || 'mp4'
  const dest = `${cacheDir.replace(/\/?$/, '/')}peartube-upload-${Date.now()}.${ext}`
  await fs.copyAsync({ from: srcUri, to: dest })
  return dest
}

async function deleteCachedFile(uri: string | null | undefined): Promise<void> {
  if (!uri) return
  try {
    const fs = await getFileSystem()
    if (fs && typeof fs.deleteAsync === 'function') {
      await fs.deleteAsync(uri, { idempotent: true })
    }
  } catch {
    // best-effort cleanup
  }
}

function titleFromFilename(name: string): string {
  return name.replace(/\.[^/.]+$/, '')
}

function scheduleThumbnailGeneration(
  generateThumbnail: (videoUri: string, durationMs?: number) => Promise<string | null | undefined>,
  videoUri: string,
  durationMs?: number,
): void {
  InteractionManager.runAfterInteractions(() => {
    void generateThumbnail(videoUri, durationMs).catch((err) => {
      console.log('[Studio] Background thumbnail generation failed:', err)
    })
  })
}

async function pickPearStudioVideo(
  pickVideoFile: () => Promise<StudioPickerFileResult>,
  onSelected: (filePath: string, name: string, size: number) => void,
): Promise<void> {
  try {
    console.log('[Studio] Opening native file picker...')
    const result = await pickVideoFile()

    if (!result) {
      console.log('[Studio] File picker not available')
      Alert.alert('Not available', 'Native file picker is not available')
      return
    }

    if ('cancelled' in result && result.cancelled) {
      console.log('[Studio] File picker cancelled')
      return
    }

    if ('filePath' in result) {
      console.log('[Studio] File selected:', result.filePath, 'size:', result.size)
      onSelected(result.filePath, result.name, result.size)
    }
  } catch (err: any) {
    console.error('[Studio] File picker error:', err)
    Alert.alert('Error', err.message || 'Failed to open file picker')
  }
}

async function pickAndroidStudioVideo(
  cleanupTempVideo: () => Promise<void>,
  onPreparing: (preparing: boolean) => void,
  onMeta: (filename: string, size?: number, mimeType?: string) => void,
  onReady: (localUri: string) => void,
  generateThumbnail: (videoUri: string, durationMs?: number) => Promise<string | null | undefined>,
): Promise<void> {
  // copyToCacheDirectory:false → the picker returns immediately with a
  // content:// URI instead of blocking (with no UI feedback) while it copies
  // the whole file. For 1GB+ videos the inline copy is what made the screen
  // hang/"never load". We copy into cache ourselves below, with feedback.
  const docResult = await DocumentPicker.getDocumentAsync({
    type: 'video/*',
    copyToCacheDirectory: false,
    multiple: false,
  })

  if (docResult.canceled) return
  const asset = docResult.assets?.[0]
  if (!asset?.uri) return

  onMeta(
    asset.name || asset.uri.split('/').pop() || 'Untitled',
    typeof asset.size === 'number' ? asset.size : undefined,
    typeof asset.mimeType === 'string' ? asset.mimeType : undefined,
  )
  void cleanupTempVideo()

  // Materialize a real file:// path the backend can stream from. Show a
  // "Preparing…" state so the user isn't staring at a frozen/black screen.
  onPreparing(true)
  try {
    const localUri = await copyPickedVideoToCache(asset.uri, asset.name || undefined)
    onReady(localUri)
    scheduleThumbnailGeneration(generateThumbnail, localUri)
  } catch (err: any) {
    console.error('[Studio] Failed to prepare video:', err)
    Alert.alert('Could not prepare video', err?.message || 'Failed to read the selected video. Please try again.')
  } finally {
    onPreparing(false)
  }
}

async function pickIOSStudioVideo(
  onSelected: (uri: string, filename: string, duration?: number) => void,
  generateThumbnail: (videoUri: string, durationMs?: number) => Promise<string | null | undefined>,
): Promise<void> {
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (status !== 'granted') {
    Alert.alert('Permission needed', 'Please grant permission to access your videos')
    return
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    allowsEditing: false,
    videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
  })

  if (!result.canceled && result.assets[0]) {
    const asset = result.assets[0]
    const filename = asset.uri.split('/').pop() || 'Untitled'
    onSelected(asset.uri, filename, asset.duration ?? undefined)
    scheduleThumbnailGeneration(generateThumbnail, asset.uri, asset.duration ?? undefined)
  }
}

async function pickPearStudioThumbnail(
  pickImageFile: () => Promise<StudioPickerFileResult>,
  onSelected: (filePath: string, dataUrl?: string) => void,
): Promise<void> {
  try {
    console.log('[Studio] Opening native image file picker...')
    const result = await pickImageFile()
    console.log('[Studio] pickImageFile result:', JSON.stringify(result))

    if (!result) {
      console.log('[Studio] Image picker not available')
      return
    }

    if ('cancelled' in result && result.cancelled) {
      console.log('[Studio] Image picker cancelled')
      return
    }

    if ('filePath' in result) {
      console.log('[Studio] Thumbnail selected:', result.filePath)
      const dataUrl = 'dataUrl' in result && typeof result.dataUrl === 'string' ? result.dataUrl : undefined
      onSelected(result.filePath, dataUrl)
      console.log('[Studio] setThumbnailFilePath called with:', result.filePath)
      if (dataUrl) {
        console.log('[Studio] setThumbnailUri called with dataUrl (length:', dataUrl.length, ')')
      }
    }
  } catch (err: any) {
    console.error('[Studio] Image picker error:', err)
    Alert.alert('Error', err.message || 'Failed to open image picker')
  }
}

async function pickNativeStudioThumbnail(
  onSelected: (uri: string) => void,
): Promise<void> {
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (status !== 'granted') {
    Alert.alert('Permission needed', 'Please grant permission to access your photos')
    return
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [16, 9],
    quality: 0.8,
  })

  if (!result.canceled && result.assets[0]) {
    console.log('[Studio] Custom thumbnail selected:', result.assets[0].uri)
    onSelected(result.assets[0].uri)
  }
}

async function generateStudioThumbnail(
  videoUri: string,
  durationMs: number | undefined,
  genId: number,
  isCurrent: (genId: number) => boolean,
  onStart: () => void,
  onSuccess: (uri: string) => void,
  onError: (message: string) => void,
  onDone: () => void,
): Promise<string | null> {
  if (isPear) return null // Desktop handles thumbnails server-side
  try {
    onStart()
    const primaryTime = durationMs ? Math.floor(durationMs * 0.1) : 1000
    const times = Array.from(new Set([primaryTime, 1000, 2000].filter((t) => t >= 0)))

    for (const timeMs of times) {
      try {
        console.log('[Studio] Generating thumbnail at', timeMs, 'ms')
        const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
          time: timeMs,
          quality: 0.7,
        })
        console.log('[Studio] Thumbnail generated:', uri)
        // Ignore stale generations (user picked another video)
        if (!isCurrent(genId)) return null
        onSuccess(uri)
        return uri
      } catch (err) {
        console.log('[Studio] Thumbnail attempt failed at', timeMs, 'ms:', err)
      }
    }

    if (isCurrent(genId)) {
      onError('Could not generate thumbnail. Please pick an image.')
    }

    return null
  } catch (err) {
    console.log('[Studio] Thumbnail generation failed:', err)
    onError('Could not generate thumbnail. Please pick an image.')
    return null
  } finally {
    onDone()
  }
}

function validateStudioUploadInput(
  selectedVideo: string | null,
  title: string,
  identity: { driveKey?: string } | null | undefined,
): string | null {
  if (!selectedVideo) {
    Alert.alert('No video selected', 'Please select a video to upload')
    return null
  }
  if (!title.trim()) {
    Alert.alert('Title required', 'Please enter a title for your video')
    return null
  }
  if (!identity) {
    console.error('[Studio] No identity! Please create one in Profile first')
    Alert.alert('No channel yet', 'Create your channel from the Profile screen first.')
    return null
  }
  if (!identity.driveKey) {
    console.error('[Studio] Identity missing driveKey')
    Alert.alert('Channel error', 'Your channel is missing its key. Please recreate it from the Profile screen.')
    return null
  }
  return identity.driveKey
}

function buildStudioEpisodeMediaInput(
  enabled: boolean,
  seriesId: string,
  seriesTitle: string,
  tmdbSeriesId: string,
  seasonNumber: string,
  episodeNumber: string,
  expectedEpisodeCount: string,
): StudioEpisodeMediaInput {
  return {
    enabled,
    seriesId,
    seriesTitle,
    tmdbId: tmdbSeriesId,
    seasonNumber,
    episodeNumber,
    expectedEpisodeCount,
  }
}

function nativeSkipThumbnailGeneration(
  thumbnailGenerating: boolean,
  thumbnailFilePath: string | null,
): boolean {
  if (Platform.OS === 'android') return true
  return thumbnailGenerating || !!thumbnailFilePath
}

async function attachStudioThumbnail(
  uploadThumbnailForVideo: (videoId: string, thumbPath: string) => Promise<boolean>,
  videoId: string | null | undefined,
  thumbnailFilePath: string | null,
): Promise<void> {
  if (!thumbnailFilePath || !videoId) {
    console.log('[Studio] No thumbnail to upload, thumbnailFilePath:', thumbnailFilePath, 'videoId:', videoId)
    return
  }
  console.log('[Studio] Uploading thumbnail from file:', thumbnailFilePath)
  try {
    const uploaded = await uploadThumbnailForVideo(videoId, thumbnailFilePath)
    console.log('[Studio] Thumbnail upload result:', uploaded)
  } catch (thumbErr: any) {
    console.error('[Studio] Failed to upload thumbnail:', thumbErr?.message || thumbErr)
    // Don't fail the whole upload if thumbnail fails
  }
}

async function runPearStudioUpload(args: {
  uploadVideo: any
  filePath: string
  title: string
  mimeType: string
  selectedCategory: string
  media: StudioEpisodeMediaInput
  thumbnailFilePath: string | null
  rpc: any
  driveKey: string
  loadVideos: (driveKey: string) => Promise<void> | void
  uploadThumbnailForVideo: (videoId: string, thumbPath: string) => Promise<boolean>
  onProgress: (progress: number, speed?: number, eta?: number, transcoding?: boolean) => void
}): Promise<void> {
  const skipThumbnail = !!args.thumbnailFilePath
  console.log('[Studio] Uploading via Pear:', args.filePath, 'category:', args.selectedCategory, 'skipThumbnail:', skipThumbnail)
  const video = await uploadStudioVideo(args.uploadVideo, {
    filePath: args.filePath,
    title: args.title,
    mimeType: args.mimeType,
    category: args.selectedCategory,
    onProgress: args.onProgress,
    skipThumbnailGeneration: skipThumbnail,
    media: args.media,
  })
  const videoId = video?.id

  if (args.thumbnailFilePath && videoId && args.rpc) {
    await attachStudioThumbnail(args.uploadThumbnailForVideo, videoId, args.thumbnailFilePath)
  }

  await args.loadVideos(args.driveKey)
}

async function runNativeStudioUpload(args: {
  uploadVideo: any
  selectedVideo: string
  title: string
  mimeType: string
  selectedCategory: string
  media: StudioEpisodeMediaInput
  thumbnailGenerating: boolean
  thumbnailFilePath: string | null
  uploadThumbnailForVideo: (videoId: string, thumbPath: string) => Promise<boolean>
  onProgress: (progress: number, speed?: number, eta?: number, transcoding?: boolean) => void
}): Promise<void> {
  // Prefer the RN-generated thumbnail when available.
  // Keep backend (bare-ffmpeg) thumbnail generation available as a fallback
  // on iOS only. (Android backend thumbnail generation has been crash-prone.)
  const skipThumbnail = nativeSkipThumbnailGeneration(args.thumbnailGenerating, args.thumbnailFilePath)

  const video = await uploadStudioVideo(args.uploadVideo, {
    filePath: args.selectedVideo,
    title: args.title,
    mimeType: args.mimeType,
    category: args.selectedCategory,
    onProgress: args.onProgress,
    skipThumbnailGeneration: skipThumbnail,
    media: args.media,
  })

  const videoId = video?.id
  console.log('[Studio] Upload complete, videoId:', videoId, 'skippedThumbnail:', skipThumbnail)
  await attachStudioThumbnail(args.uploadThumbnailForVideo, videoId, args.thumbnailFilePath)
}

function showSourceOffloadStopped(message: string): void {
  if (Platform.OS === 'web') window.alert(message)
  else Alert.alert('Source offload stopped', message)
}

function buildOffloadConfirmMessage(
  title: string,
  publicationId: string,
  byteLength: number,
  limitations: string[],
): string {
  const freed = byteLength ? ` (${formatBytes(byteLength)})` : ''
  const limitationsText = limitations.length
    ? `\n\nEvidence limitations:\n${limitations.map((value: string) => `• ${value}`).join('\n')}`
    : ''
  return `Delete this device's source bytes for "${title}"${freed}?\n\nPublication: ${publicationId}\n\nThis cannot guarantee the media remains recoverable. Other copies may disappear after confirmation.${limitationsText}\n\nContinue only if you accept permanent loss risk.`
}

async function confirmSourceOffloadWithUser(message: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (Platform.OS === 'web') {
      resolve(window.confirm(message))
      return
    }
    Alert.alert('Confirm source offload', message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'I understand — delete source', style: 'destructive', onPress: () => resolve(true) },
    ])
  })
}

function offloadInfoFromAssessment(res: any, busy?: boolean): StudioOffloadInfo {
  return {
    eligible: res?.success === true && res?.eligible === true,
    byteLength: Number(res?.byteLength) || 0,
    publicationId: res?.publicationId,
    assessmentId: res?.assessmentId,
    evidenceDigest: res?.evidenceDigest,
    confirmationNonce: res?.confirmationNonce,
    policyVersion: res?.policyVersion,
    limitations: Array.isArray(res?.limitations) ? res.limitations : [],
    busy,
  }
}

function isFreshOffloadAssessmentReady(fresh: any): boolean {
  return !!(
    fresh?.success &&
    fresh.eligible &&
    fresh.publicationId &&
    fresh.assessmentId &&
    fresh.evidenceDigest &&
    fresh.confirmationNonce &&
    fresh.policyVersion
  )
}

async function runStudioSourceOffload(args: {
  item: Video
  info: StudioOffloadInfo
  rpc: any
  assessedOffloadRef: { current: Set<string> }
  setOffloadInfo: Dispatch<SetStateAction<Record<string, StudioOffloadInfo>>>
}): Promise<void> {
  const { item, info, rpc, assessedOffloadRef, setOffloadInfo } = args
  if (!info.publicationId || typeof rpc?.assessSourceOffload !== 'function') return
  setOffloadInfo((prev) => ({ ...prev, [item.id]: { ...prev[item.id], busy: true } }))

  try {
    const fresh = await rpc?.assessSourceOffload({ publicationId: info.publicationId })
    if (!isFreshOffloadAssessmentReady(fresh)) {
      assessedOffloadRef.current.delete(info.publicationId)
      setOffloadInfo((prev) => ({ ...prev, [item.id]: { ...prev[item.id], eligible: false, busy: false } }))
      showSourceOffloadStopped(
        `Source offload is no longer safe. ${fresh?.reason || 'Current archive evidence is insufficient.'}`,
      )
      return
    }

    const freshInfo: StudioOffloadInfo = {
      eligible: true,
      byteLength: Number(fresh.byteLength) || 0,
      publicationId: fresh.publicationId,
      assessmentId: fresh.assessmentId,
      evidenceDigest: fresh.evidenceDigest,
      confirmationNonce: fresh.confirmationNonce,
      policyVersion: fresh.policyVersion,
      limitations: Array.isArray(fresh.limitations) ? fresh.limitations : [],
      busy: true,
    }
    setOffloadInfo((prev) => ({ ...prev, [item.id]: freshInfo }))

    const confirmed = await confirmSourceOffloadWithUser(
      buildOffloadConfirmMessage(
        item.title,
        fresh.publicationId,
        freshInfo.byteLength,
        freshInfo.limitations || [],
      ),
    )
    if (!confirmed) {
      setOffloadInfo((prev) => ({ ...prev, [item.id]: { ...prev[item.id], busy: false } }))
      return
    }

    const res = await rpc?.confirmSourceOffload({
      publicationId: fresh.publicationId,
      assessmentId: fresh.assessmentId,
      evidenceDigest: fresh.evidenceDigest,
      confirmationNonce: fresh.confirmationNonce,
      policyVersion: fresh.policyVersion,
      confirmIrrecoverableRisk: true,
    })
    if (res?.success) {
      setOffloadInfo((prev) => ({
        ...prev,
        [item.id]: {
          eligible: false,
          byteLength: freshInfo.byteLength,
          publicationId: fresh.publicationId,
          offloaded: true,
          busy: false,
        },
      }))
      return
    }

    assessedOffloadRef.current.delete(fresh.publicationId)
    setOffloadInfo((prev) => ({ ...prev, [item.id]: { ...prev[item.id], eligible: false, busy: false } }))
    showSourceOffloadStopped(
      `Couldn't delete the local source. ${res?.reason || 'The evidence or policy changed; reassess before trying again.'}`,
    )
  } catch (err: unknown) {
    assessedOffloadRef.current.delete(info.publicationId)
    setOffloadInfo((prev) => ({ ...prev, [item.id]: { ...prev[item.id], eligible: false, busy: false } }))
    showSourceOffloadStopped(err instanceof Error ? err.message : 'Failed to delete local source')
  }
}

async function confirmDeleteStudioVideo(videoTitle: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (Platform.OS === 'web') {
      resolve(window.confirm(`Delete "${videoTitle}"?\n\nThis will permanently delete the video from your channel.`))
      return
    }
    Alert.alert(
      'Delete Video',
      `Delete "${videoTitle}"?\n\nThis will permanently delete the video from your channel.`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Delete', style: 'destructive', onPress: () => resolve(true) },
      ],
    )
  })
}

function showStudioError(errorMsg: string): void {
  if (Platform.OS === 'web') {
    window.alert(`Error: ${errorMsg}`)
  } else {
    Alert.alert('Error', errorMsg)
  }
}

async function runDeleteStudioVideo(args: {
  videoId: string
  videoTitle: string
  videos: Video[]
  removeVideo: (videoId: string) => void
  rpc: any
  driveKey: string | undefined
  loadVideos: (driveKey: string, opts?: { allowEmptyResult?: boolean }) => Promise<void>
}): Promise<void> {
  const confirmed = await confirmDeleteStudioVideo(args.videoTitle)
  if (!confirmed) return

  args.removeVideo(args.videoId)

  try {
    const result = await args.rpc?.deleteVideo({ videoId: args.videoId })
    if (result?.success) {
      if (args.driveKey) {
        args.loadVideos(args.driveKey, { allowEmptyResult: true }).catch(() => {})
      }
      return
    }

    const errorMsg = result?.error || 'Failed to delete video'
    if (args.driveKey) {
      args.loadVideos(args.driveKey).catch(() => {})
    }
    showStudioError(errorMsg)
  } catch (err: any) {
    console.error('[Studio] Delete failed:', err)
    if (args.driveKey) {
      args.loadVideos(args.driveKey).catch(() => {})
    }
    showStudioError(err.message || 'Failed to delete video')
  }
}

function resolvePublishedVideoRef(item: any): string {
  if (item.path && typeof item.path === 'string' && item.path.startsWith('/')) {
    return item.path
  }
  return item.id
}

function buildPublishedPlaybackRequest(item: any, channelKey: string, videoRef: string) {
  return {
    channelKey,
    videoId: videoRef,
    publicBeeKey: item.publicBeeKey || undefined,
    blobId: item.blobId || undefined,
    blobsCoreKey: item.blobsCoreKey || undefined,
    mimeType: item.mimeType || undefined,
  }
}

async function playPublishedStudioVideo(args: {
  item: any
  rpc: any
  identityDriveKey: string | undefined
  loadAndPlayVideo: (video: any, url: string) => void
}): Promise<void> {
  if (!args.rpc) return
  const channelKey = args.item?.channelKey || args.identityDriveKey
  if (!channelKey || !args.item?.id) return

  const videoRef = resolvePublishedVideoRef(args.item)
  const cacheKey = makeVideoUrlCacheKey(
    channelKey,
    videoRef,
    args.item.blobId || undefined,
    args.item.blobsCoreKey || undefined,
  )
  const playbackRequest = buildPublishedPlaybackRequest(args.item, channelKey, videoRef)
  const video = { ...args.item, channelKey }

  try {
    const result = await args.rpc.preparePlayback(playbackRequest)
    if (result?.url) {
      if (cacheKey) setCachedVideoUrl(cacheKey, result.url)
      args.loadAndPlayVideo(video, result.url)
      return
    }
    Alert.alert('Playback unavailable', 'Could not prepare this video for playback yet.')
  } catch (err: any) {
    console.error('[Studio] Failed to play published video:', err?.message || err)
    Alert.alert('Playback unavailable', err?.message || 'Could not prepare this video for playback yet.')
  }
}

async function shareStudioChannelInvite(code: string): Promise<void> {
  try {
    await Share.share({ message: code, title: 'PearTube device invite' })
  } catch {
    await Clipboard.setStringAsync(code)
    Alert.alert('Copied', 'Invite code copied to clipboard')
  }
}

async function createStudioChannelInvite(
  rpc: any,
  driveKey: string | undefined,
  setInviteCode: (code: string) => void,
  setLoading: (loading: boolean) => void,
): Promise<void> {
  if (!rpc || !driveKey) return
  setLoading(true)
  try {
    const res = await rpc.createDeviceInvite(driveKey)
    if (!res?.inviteCode) throw new Error('Failed to create invite')
    setInviteCode(res.inviteCode)
    haptics.success()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to create invite'
    console.error('[Studio] Failed to create channel invite:', message)
    Alert.alert('Error', message)
  } finally {
    setLoading(false)
  }
}

async function pairStudioChannelDevice(args: {
  rpc: any
  code: string
  deviceName: string
  setPairing: (pairing: boolean) => void
  clearPairFields: () => void
  reloadDevices: () => Promise<void>
}): Promise<void> {
  if (!args.rpc) return
  const code = args.code.trim()
  if (!code) return
  args.setPairing(true)
  try {
    const res = await args.rpc.pairDevice({
      inviteCode: code,
      deviceName: args.deviceName.trim() || undefined,
    })
    if (!res?.success) throw new Error('Pair failed')
    args.clearPairFields()
    haptics.success()
    Alert.alert('Linked', 'This device is now part of your channel.')
    await args.reloadDevices()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to link device'
    console.error('[Studio] Pair device failed:', message)
    Alert.alert('Error', message)
  } finally {
    args.setPairing(false)
  }
}

function StudioScreenHeader({
  topInset,
  hasIdentity,
  publisherEyebrow,
  onSearch,
  onSetupChannel,
}: {
  topInset: number
  hasIdentity: boolean
  publisherEyebrow: string
  onSearch: () => void
  onSetupChannel: () => void
}) {
  return (
    <View style={{ paddingTop: topInset }}>
      <ScreenHeader
        title="STUDIO"
        eyebrow={publisherEyebrow}
        right={
          <>
            <CastHeaderButton size={18} />
            <IconButton
              icon="search"
              accessibilityLabel="Search"
              variant="plain"
              size={36}
              onPress={onSearch}
            />
          </>
        }
      />
      {!hasIdentity ? (
        <Pressable onPress={onSetupChannel} style={styles.setupBanner}>
          <Meta tone="accent">Set up your channel to start publishing →</Meta>
        </Pressable>
      ) : null}
    </View>
  )
}

function StudioThumbnailPreview({
  thumbnailUri,
  thumbnailGenerating,
  thumbnailError,
  onPickThumbnail,
}: {
  thumbnailUri: string | null
  thumbnailGenerating: boolean
  thumbnailError: string | null
  onPickThumbnail: () => void
}) {
  let emptyLabel = 'Thumbnail not available'
  if (isPear) emptyLabel = 'Click below to add thumbnail'
  else if (thumbnailGenerating) emptyLabel = 'Generating thumbnail...'
  else if (thumbnailError) emptyLabel = thumbnailError

  return (
    <Panel padded={false} style={styles.thumbPanel}>
      <View style={styles.thumbAspect}>
        {thumbnailUri ? (
          <View style={styles.thumbFill}>
            <Image
              source={{ uri: thumbnailUri }}
              style={styles.thumbFill}
              resizeMode="cover"
            />
            {thumbnailGenerating ? (
              <View style={styles.thumbScrim}>
                <ActivityIndicator color={colors.text} />
              </View>
            ) : null}
          </View>
        ) : (
          <View style={styles.thumbPlaceholder}>
            <Feather name="film" color={colors.textMuted} size={48} />
            <Meta tone="muted" style={styles.thumbPlaceholderMeta}>{emptyLabel}</Meta>
          </View>
        )}
      </View>
      <Pressable onPress={onPickThumbnail} style={styles.thumbAction}>
        <Feather name="image" color={colors.textMuted} size={16} />
        <Meta tone="muted">
          {thumbnailUri ? 'Change Thumbnail' : 'Add Thumbnail'}
        </Meta>
      </Pressable>
    </Panel>
  )
}

function StudioEpisodeMetadataFields({
  episodeMetadataEnabled,
  setEpisodeMetadataEnabled,
  seriesId,
  setSeriesId,
  seriesTitle,
  setSeriesTitle,
  tmdbSeriesId,
  setTmdbSeriesId,
  seasonNumber,
  setSeasonNumber,
  episodeNumber,
  setEpisodeNumber,
  expectedEpisodeCount,
  setExpectedEpisodeCount,
}: {
  episodeMetadataEnabled: boolean
  setEpisodeMetadataEnabled: (enabled: boolean) => void
  seriesId: string
  setSeriesId: (value: string) => void
  seriesTitle: string
  setSeriesTitle: (value: string) => void
  tmdbSeriesId: string
  setTmdbSeriesId: (value: string) => void
  seasonNumber: string
  setSeasonNumber: (value: string) => void
  episodeNumber: string
  setEpisodeNumber: (value: string) => void
  expectedEpisodeCount: string
  setExpectedEpisodeCount: (value: string) => void
}) {
  return (
    <View style={styles.fieldBlock}>
      <Eyebrow>COLLECTION METADATA (OPTIONAL)</Eyebrow>
      <View style={styles.chipWrap}>
        <Chip
          label="Standalone"
          selected={!episodeMetadataEnabled}
          onPress={() => setEpisodeMetadataEnabled(false)}
        />
        <Chip
          label="Series episode"
          selected={episodeMetadataEnabled}
          onPress={() => setEpisodeMetadataEnabled(true)}
        />
      </View>
      {episodeMetadataEnabled ? (
        <View style={styles.episodeFields}>
          <StudioInput
            accessibilityLabel="Series ID"
            placeholder="Series ID (lowercase, stable)"
            value={seriesId}
            onChangeText={setSeriesId}
            maxLength={128}
            autoCapitalize="none"
          />
          <StudioInput
            accessibilityLabel="Series title"
            placeholder="Series title"
            value={seriesTitle}
            onChangeText={setSeriesTitle}
            maxLength={512}
          />
          <StudioInput
            accessibilityLabel="TMDB series ID"
            placeholder="TMDB series ID"
            value={tmdbSeriesId}
            onChangeText={setTmdbSeriesId}
            maxLength={20}
            keyboardType="number-pad"
          />
          <View style={styles.episodeRow}>
            <StudioInput
              accessibilityLabel="Season number"
              placeholder="Season"
              value={seasonNumber}
              onChangeText={setSeasonNumber}
              maxLength={6}
              keyboardType="number-pad"
              style={styles.episodeInput}
            />
            <StudioInput
              accessibilityLabel="Episode number"
              placeholder="Episode"
              value={episodeNumber}
              onChangeText={setEpisodeNumber}
              maxLength={6}
              keyboardType="number-pad"
              style={styles.episodeInput}
            />
            <StudioInput
              accessibilityLabel="Expected episode count"
              placeholder="Expected"
              value={expectedEpisodeCount}
              onChangeText={setExpectedEpisodeCount}
              maxLength={6}
              keyboardType="number-pad"
              style={styles.episodeInput}
            />
          </View>
        </View>
      ) : null}
    </View>
  )
}

function StudioUploadProgress({
  uploadProgress,
  isTranscoding,
  uploadSpeed,
  uploadEta,
}: {
  uploadProgress: number
  isTranscoding: boolean
  uploadSpeed: number
  uploadEta: number
}) {
  const statusText = isTranscoding
    ? `Optimizing for streaming… ${uploadProgress}%`
    : `Adding to your channel… ${uploadProgress}%` +
      (uploadSpeed > 0 ? ` · ${formatSpeed(uploadSpeed)}` : '') +
      (uploadEta > 0 ? ` · ${formatEta(uploadEta)} left` : '')

  return (
    <View style={styles.progressBlock}>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${uploadProgress}%` }]} />
      </View>
      <View style={styles.progressMetaRow}>
        <ActivityIndicator color={colors.primary} size="small" />
        <Meta tone="muted" style={styles.progressMeta}>{statusText}</Meta>
      </View>
      <Tag
        label={isTranscoding ? 'ENCODING' : 'PUBLISHING'}
        tone={isTranscoding ? 'warning' : 'accent'}
      />
    </View>
  )
}

function StudioPublishButton({
  title,
  thumbnailGenerating,
  thumbnailFilePath,
  onPress,
}: {
  title: string
  thumbnailGenerating: boolean
  thumbnailFilePath: string | null
  onPress: () => void
}) {
  const disabled = !title.trim() || (!isPear && (thumbnailGenerating || !thumbnailFilePath))
  const label = !isPear && thumbnailGenerating
    ? 'PREPARING THUMBNAIL…'
    : (!isPear && !thumbnailFilePath)
      ? 'ADD A THUMBNAIL TO PUBLISH'
      : 'PUBLISH'

  return (
    <Button
      label={label}
      icon="upload"
      onPress={onPress}
      disabled={disabled}
      block
    />
  )
}

function StudioSelectedUploadForm(props: {
  thumbnailUri: string | null
  thumbnailGenerating: boolean
  thumbnailError: string | null
  onPickThumbnail: () => void
  onClearSelection: () => void
  title: string
  setTitle: (value: string) => void
  categoryOptions: string[]
  selectedCategory: string
  setSelectedCategory: (value: string) => void
  episodeMetadataEnabled: boolean
  setEpisodeMetadataEnabled: (enabled: boolean) => void
  seriesId: string
  setSeriesId: (value: string) => void
  seriesTitle: string
  setSeriesTitle: (value: string) => void
  tmdbSeriesId: string
  setTmdbSeriesId: (value: string) => void
  seasonNumber: string
  setSeasonNumber: (value: string) => void
  episodeNumber: string
  setEpisodeNumber: (value: string) => void
  expectedEpisodeCount: string
  setExpectedEpisodeCount: (value: string) => void
  uploading: boolean
  uploadProgress: number
  isTranscoding: boolean
  uploadSpeed: number
  uploadEta: number
  thumbnailFilePath: string | null
  onUpload: () => void
}) {
  return (
    <View style={styles.uploadForm}>
      <StudioThumbnailPreview
        thumbnailUri={props.thumbnailUri}
        thumbnailGenerating={props.thumbnailGenerating}
        thumbnailError={props.thumbnailError}
        onPickThumbnail={props.onPickThumbnail}
      />

      <Panel style={styles.selectedRow}>
        <View style={styles.selectedIcon}>
          <Feather name="film" color={colors.primary} size={20} />
        </View>
        <Text style={styles.selectedLabel} numberOfLines={1}>
          Video selected
        </Text>
        <IconButton
          icon="trash-2"
          accessibilityLabel="Clear selected video"
          variant="plain"
          size={32}
          onPress={props.onClearSelection}
        />
      </Panel>

      {!isPear && props.thumbnailError ? (
        <Panel tone="muted">
          <Meta tone="muted">
            Thumbnail generation failed. Tap Add Thumbnail to pick an image.
          </Meta>
        </Panel>
      ) : null}

      <StudioInput
        placeholder="Video title"
        value={props.title}
        onChangeText={props.setTitle}
      />

      <View style={styles.fieldBlock}>
        <Eyebrow>CATEGORY</Eyebrow>
        <View style={styles.chipWrap}>
          {props.categoryOptions.map((cat) => (
            <Chip
              key={cat}
              label={cat}
              selected={props.selectedCategory === cat}
              onPress={() => props.setSelectedCategory(cat)}
            />
          ))}
        </View>
      </View>

      <StudioEpisodeMetadataFields
        episodeMetadataEnabled={props.episodeMetadataEnabled}
        setEpisodeMetadataEnabled={props.setEpisodeMetadataEnabled}
        seriesId={props.seriesId}
        setSeriesId={props.setSeriesId}
        seriesTitle={props.seriesTitle}
        setSeriesTitle={props.setSeriesTitle}
        tmdbSeriesId={props.tmdbSeriesId}
        setTmdbSeriesId={props.setTmdbSeriesId}
        seasonNumber={props.seasonNumber}
        setSeasonNumber={props.setSeasonNumber}
        episodeNumber={props.episodeNumber}
        setEpisodeNumber={props.setEpisodeNumber}
        expectedEpisodeCount={props.expectedEpisodeCount}
        setExpectedEpisodeCount={props.setExpectedEpisodeCount}
      />

      {props.uploading ? (
        <StudioUploadProgress
          uploadProgress={props.uploadProgress}
          isTranscoding={props.isTranscoding}
          uploadSpeed={props.uploadSpeed}
          uploadEta={props.uploadEta}
        />
      ) : (
        <StudioPublishButton
          title={props.title}
          thumbnailGenerating={props.thumbnailGenerating}
          thumbnailFilePath={props.thumbnailFilePath}
          onPress={props.onUpload}
        />
      )}
    </View>
  )
}

function StudioPickVideoButton({
  pickingVideo,
  preparingVideo,
  onPress,
}: {
  pickingVideo: boolean
  preparingVideo: boolean
  onPress: () => void
}) {
  let label = 'Choose a video to share'
  if (preparingVideo) label = 'Preparing video…'
  else if (pickingVideo) label = 'Opening picker…'

  return (
    <Panel style={styles.dropZone}>
      <Eyebrow tone="accent">DROP / SELECT MEDIA</Eyebrow>
      <Meta tone="muted" style={styles.dropHint}>{label}</Meta>
      <Button
        label="SELECT FILE"
        icon="upload"
        onPress={onPress}
        disabled={pickingVideo || preparingVideo}
        loading={preparingVideo || pickingVideo}
        block
      />
    </Panel>
  )
}

function StudioChannelDevicesPanel({
  channelDevices,
  channelDevicesLoading,
  channelInviteCode,
  channelInviteLoading,
  channelPairCode,
  setChannelPairCode,
  channelPairName,
  setChannelPairName,
  channelPairing,
  hasDriveKey,
  onCreateInvite,
  onShareInvite,
  onPairDevice,
}: {
  channelDevices: Array<{ keyHex?: string; deviceName?: string }>
  channelDevicesLoading: boolean
  channelInviteCode: string | null
  channelInviteLoading: boolean
  channelPairCode: string
  setChannelPairCode: (value: string) => void
  channelPairName: string
  setChannelPairName: (value: string) => void
  channelPairing: boolean
  hasDriveKey: boolean
  onCreateInvite: () => void
  onShareInvite: (code: string) => void
  onPairDevice: () => void
}) {
  return (
    <View style={styles.section}>
      <SectionHeader title="CHANNEL DEVICES" flush />
      <Body tone="muted" size="sm" style={styles.devicesBlurb}>
        Link another device so it can publish to this channel. This shares publishing
        authority for the channel — not your viewing state.
      </Body>

      <Panel tone="muted" style={styles.devicesPanel}>
        {channelDevices.length ? (
          <View style={styles.deviceList}>
            {channelDevices.map((device, idx) => (
              <View key={device?.keyHex || idx} style={styles.deviceRow}>
                <Feather name="smartphone" color={colors.textSecondary} size={16} />
                <View style={styles.deviceCopy}>
                  <Text style={styles.deviceName}>{device?.deviceName || `Device ${idx + 1}`}</Text>
                  <Meta tone="muted" numberOfLines={1}>{device?.keyHex || ''}</Meta>
                </View>
              </View>
            ))}
          </View>
        ) : (
          <Meta tone="muted">
            {channelDevicesLoading ? 'Looking for linked devices…' : 'Just this device so far.'}
          </Meta>
        )}

        {channelInviteCode ? (
          <Panel style={styles.inviteBox}>
            <Eyebrow>INVITE CODE — ENTER IT ON YOUR OTHER DEVICE</Eyebrow>
            <Text selectable style={styles.inviteCode}>{channelInviteCode}</Text>
            <View style={styles.inviteActions}>
              <Button
                label="COPY"
                variant="secondary"
                icon="copy"
                size="sm"
                onPress={async () => {
                  await Clipboard.setStringAsync(channelInviteCode)
                  Alert.alert('Copied', 'Invite code copied to clipboard')
                }}
                style={styles.inviteBtn}
              />
              <Button
                label="SHARE"
                variant="secondary"
                icon="share-2"
                size="sm"
                onPress={() => onShareInvite(channelInviteCode)}
                style={styles.inviteBtn}
              />
            </View>
          </Panel>
        ) : null}

        <Button
          label="LINK A DEVICE"
          icon="plus"
          onPress={onCreateInvite}
          disabled={channelInviteLoading || !hasDriveKey}
          loading={channelInviteLoading}
          block
        />

        <StudioInput
          placeholder="Paste invite code"
          value={channelPairCode}
          onChangeText={setChannelPairCode}
          autoCapitalize="none"
        />
        <StudioInput
          placeholder="Device name (optional)"
          value={channelPairName}
          onChangeText={setChannelPairName}
          autoCapitalize="none"
        />
        <Button
          label="LINK WITH THIS CODE"
          variant="secondary"
          icon="link"
          onPress={onPairDevice}
          disabled={channelPairing || !channelPairCode.trim()}
          loading={channelPairing}
          block
        />
      </Panel>
    </View>
  )
}

function StudioPublishedVideoRow({
  item,
  offload,
  onPlay,
  onEdit,
  onOffload,
  onDelete,
}: {
  item: Video
  offload?: StudioOffloadInfo
  onPlay: () => void
  onEdit: () => void
  onOffload: () => void
  onDelete: () => void
}) {
  let offloadControl: ReactNode = null
  if (offload?.offloaded) {
    offloadControl = (
      <View style={styles.publishedActionSlot}>
        <Feather name="cloud" color={colors.text} size={16} />
      </View>
    )
  } else if (offload?.eligible) {
    offloadControl = (
      <Pressable
        onPress={onOffload}
        disabled={offload?.busy}
        style={styles.publishedActionSlot}
        accessibilityLabel="Free up local space"
      >
        {offload?.busy
          ? <ActivityIndicator size="small" color={colors.primary} />
          : <Feather name="download-cloud" color={colors.primary} size={18} />}
      </Pressable>
    )
  }

  return (
    <Panel padded={false} style={styles.publishedRow}>
      <Pressable
        onPress={onPlay}
        style={styles.publishedHit}
        accessibilityRole="button"
        accessibilityLabel={`Play ${item.title}`}
      >
        <View style={styles.publishedThumb}>
          {item.thumbnail ? (
            <Image source={{ uri: item.thumbnail }} style={styles.publishedThumbImg} resizeMode="cover" />
          ) : (
            <Ionicons name="play" color={colors.text} size={16} />
          )}
        </View>
        <View style={styles.publishedCopy}>
          <Text style={styles.publishedTitle} numberOfLines={2}>{item.title}</Text>
          <Meta tone="muted">
            {formatBytes(item.size)} · {formatDate(item.uploadedAt)}
          </Meta>
        </View>
      </Pressable>
      <IconButton
        icon="edit-2"
        accessibilityLabel="Edit video"
        variant="plain"
        size={40}
        onPress={onEdit}
      />
      {offloadControl}
      <IconButton
        icon="trash-2"
        accessibilityLabel="Delete video"
        variant="plain"
        size={40}
        onPress={onDelete}
      />
    </Panel>
  )
}

function StudioScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { identity, videos, rpc, uploadVideo, pickVideoFile, pickImageFile, loadVideos, removeVideo } = useApp()
  const { pauseVideo, closeVideo, suppressForegroundRestoreOnce, suppressForegroundRestoreFor, clearLastClosedVideo, loadAndPlayVideo } = useVideoPlayerActions()
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadSpeed, setUploadSpeed] = useState(0)  // bytes/sec
  const [uploadEta, setUploadEta] = useState(0)      // seconds remaining
  const [isTranscoding, setIsTranscoding] = useState(false)  // true during audio transcode phase
  const [title, setTitle] = useState('')
  const [selectedVideo, setSelectedVideo] = useState<string | null>(null)
  const [selectedCategory, setSelectedCategory] = useState('Other')
  const [episodeMetadataEnabled, setEpisodeMetadataEnabled] = useState(false)
  const [seriesId, setSeriesId] = useState('')
  const [seriesTitle, setSeriesTitle] = useState('')
  const [tmdbSeriesId, setTmdbSeriesId] = useState('')
  const [seasonNumber, setSeasonNumber] = useState('')
  const [episodeNumber, setEpisodeNumber] = useState('')
  const [expectedEpisodeCount, setExpectedEpisodeCount] = useState('')
  const categoryOptions = ['Music', 'Gaming', 'Tech', 'Education', 'Entertainment', 'Vlog', 'Other']
  const [filePath, setFilePath] = useState<string | null>(null) // Pear: actual file path
  const [fileSize, setFileSize] = useState<number>(0)
  const [mimeType, setMimeType] = useState<string>('video/mp4')
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(null) // Preview URI (data URL or file URI)
  const [thumbnailFilePath, setThumbnailFilePath] = useState<string | null>(null) // File path/URI for uploading thumbnail
  const [videoDuration, setVideoDuration] = useState<number | null>(null)
  const [thumbnailGenerating, setThumbnailGenerating] = useState(false)
  const [thumbnailError, setThumbnailError] = useState<string | null>(null)
  const thumbnailGenIdRef = useRef(0)
  const [pickingVideo, setPickingVideo] = useState(false)
  const pickingVideoRef = useRef(false)
  const [preparingVideo, setPreparingVideo] = useState(false) // Android: copying picked file into cache
  const tempVideoUriRef = useRef<string | null>(null) // app-cache copy we created; deleted after upload/reset
  const [editingVideo, setEditingVideo] = useState<any>(null)
  // Publisher-channel pairing. This authorizes another device to publish to
  // this channel and lives here, behind Developer Mode, precisely because it is
  // not the viewer's personal-store pairing in Profile: different key, different
  // blast radius. Neither flow may borrow the other's invite or key material.
  const [channelDevices, setChannelDevices] = useState<Array<{ keyHex?: string; deviceName?: string }>>([])
  const [channelDevicesLoading, setChannelDevicesLoading] = useState(false)
  const [channelInviteCode, setChannelInviteCode] = useState<string | null>(null)
  const [channelInviteLoading, setChannelInviteLoading] = useState(false)
  const [channelPairCode, setChannelPairCode] = useState('')
  const [channelPairName, setChannelPairName] = useState('')
  const [channelPairing, setChannelPairing] = useState(false)
  // Per-publication source-offload assessments. Eligibility is only a prompt to
  // request explicit confirmation; the backend rechecks and consumes the nonce.
  const [offloadInfo, setOffloadInfo] = useState<Record<string, StudioOffloadInfo>>({})
  const assessedOffloadRef = useRef<Set<string>>(new Set())
  const tabBarMetrics = useTabBarMetrics()
  const bottomPadding = Math.max(tabBarMetrics.height + 16, insets.bottom + 16)

  // Delete the temporary cache copy we made of the picked video (Android), if any.
  const cleanupTempVideo = useCallback(async () => {
    const uri = tempVideoUriRef.current
    tempVideoUriRef.current = null
    await deleteCachedFile(uri)
  }, [])

  const uploadThumbnailForVideo = useCallback(async (videoId: string, thumbPath: string) => {
    if (!rpc || !videoId || !thumbPath) return false

    const result = await rpc.setVideoThumbnailFromFile({
      videoId,
      filePath: thumbPath,
    })

    if (!result?.success) {
      throw new Error(result?.error || 'setVideoThumbnailFromFile failed')
    }

    return true
  }, [rpc])

  const generateThumbnail = useCallback(async (videoUri: string, durationMs?: number) => {
    const genId = ++thumbnailGenIdRef.current
    return generateStudioThumbnail(
      videoUri,
      durationMs,
      genId,
      (id) => thumbnailGenIdRef.current === id,
      () => {
        setThumbnailGenerating(true)
        setThumbnailError(null)
      },
      (uri) => {
        setThumbnailUri(uri)
        setThumbnailFilePath(uri)
      },
      (message) => setThumbnailError(message),
      () => setThumbnailGenerating(false),
    )
  }, [])

  const pickThumbnail = useCallback(async () => {
    console.log('[Studio] pickThumbnail called, isPear:', isPear)
    if (isPear) {
      await pickPearStudioThumbnail(pickImageFile, (filePathValue, dataUrl) => {
        setThumbnailFilePath(filePathValue)
        if (dataUrl) setThumbnailUri(dataUrl)
      })
      return
    }

    await pickNativeStudioThumbnail((uri) => {
      setThumbnailUri(uri)
      setThumbnailFilePath(uri)
      setThumbnailError(null)
    })
  }, [pickImageFile])

  const clearVideoSelection = useCallback(() => {
    setSelectedVideo(null)
    setFilePath(null)
    setFileSize(0)
    setThumbnailUri(null)
    setThumbnailFilePath(null)
    setVideoDuration(null)
    setThumbnailError(null)
    void cleanupTempVideo()
  }, [cleanupTempVideo])

  const resetUploadForm = useCallback(() => {
    setSelectedVideo(null)
    setFilePath(null)
    setTitle('')
    setFileSize(0)
    setThumbnailUri(null)
    setThumbnailFilePath(null)
    setVideoDuration(null)
    setSelectedCategory('Other')
    setEpisodeMetadataEnabled(false)
    setSeriesId('')
    setSeriesTitle('')
    setTmdbSeriesId('')
    setSeasonNumber('')
    setEpisodeNumber('')
    setExpectedEpisodeCount('')
    setThumbnailError(null)
    void cleanupTempVideo()
  }, [cleanupTempVideo])

  const pickVideo = useCallback(async () => {
    if (pickingVideoRef.current) return
    if (AppState.currentState !== 'active') return

    pickingVideoRef.current = true
    setPickingVideo(true)
    // Opening a system picker backgrounds the app. Our VideoPlayerContext tries to
    // auto-restore the last closed video on foreground, which can cause surprise playback
    // and a black overlay. Suppress that once for picker flows.
    suppressForegroundRestoreOnce()
    suppressForegroundRestoreFor(8000)
    pauseVideo()
    closeVideo()
    clearLastClosedVideo()

    try {
      if (isPear) {
        await pickPearStudioVideo(pickVideoFile, (selectedPath, name, size) => {
          setFilePath(selectedPath)
          setSelectedVideo(selectedPath) // Use path as identifier
          setTitle(titleFromFilename(name))
          setFileSize(size)
          setMimeType('video/mp4') // Default, worker will detect
        })
        return
      }

      if (Platform.OS === 'android') {
        // Reset prior selection/preview state before prepare.
        setThumbnailUri(null)
        setThumbnailFilePath(null)
        setThumbnailError(null)
        await pickAndroidStudioVideo(
          cleanupTempVideo,
          setPreparingVideo,
          (filename, size, nextMime) => {
            setTitle(titleFromFilename(filename))
            if (typeof size === 'number') setFileSize(size)
            if (typeof nextMime === 'string') setMimeType(nextMime)
          },
          (localUri) => {
            tempVideoUriRef.current = localUri
            setSelectedVideo(localUri)
          },
          generateThumbnail,
        )
        return
      }

      await pickIOSStudioVideo(
        (uri, filename, duration) => {
          setSelectedVideo(uri)
          setTitle(titleFromFilename(filename))
          if (duration) setVideoDuration(duration)
          setThumbnailUri(null)
          setThumbnailFilePath(null)
          setThumbnailError(null)
        },
        generateThumbnail,
      )
    } catch (err: any) {
      console.error('[Studio] pickVideo error:', err)
      Alert.alert('Error', err?.message || 'Failed to open video picker')
    } finally {
      pickingVideoRef.current = false
      setPickingVideo(false)
    }
  }, [
    cleanupTempVideo,
    clearLastClosedVideo,
    closeVideo,
    generateThumbnail,
    pauseVideo,
    pickVideoFile,
    suppressForegroundRestoreFor,
    suppressForegroundRestoreOnce,
  ])

  const handleUpload = useCallback(async () => {
    console.log('[Studio] handleUpload called:', {
      selectedVideo: !!selectedVideo,
      title: title.trim(),
      identity: !!identity,
      filePath: !!filePath,
      thumbnailFilePath: thumbnailFilePath || 'none',
      thumbnailUri: thumbnailUri || 'none',
    })

    const driveKey = validateStudioUploadInput(selectedVideo, title, identity)
    if (!driveKey || !selectedVideo) return

    const media = buildStudioEpisodeMediaInput(
      episodeMetadataEnabled,
      seriesId,
      seriesTitle,
      tmdbSeriesId,
      seasonNumber,
      episodeNumber,
      expectedEpisodeCount,
    )

    setUploading(true)
    setUploadProgress(0)

    const onProgress = (progress: number, speed?: number, eta?: number, transcoding?: boolean) => {
      setUploadProgress(progress)
      if (speed !== undefined) setUploadSpeed(speed)
      if (eta !== undefined) setUploadEta(eta)
      setIsTranscoding(!!transcoding)
    }

    try {
      if (isPear && filePath) {
        await runPearStudioUpload({
          uploadVideo,
          filePath,
          title: title.trim(),
          mimeType,
          selectedCategory,
          media,
          thumbnailFilePath,
          rpc,
          driveKey,
          loadVideos,
          uploadThumbnailForVideo,
          onProgress,
        })
      } else if (rpc) {
        await runNativeStudioUpload({
          uploadVideo,
          selectedVideo,
          title: title.trim(),
          mimeType,
          selectedCategory,
          media,
          thumbnailGenerating,
          thumbnailFilePath,
          uploadThumbnailForVideo,
          onProgress,
        })
      }

      resetUploadForm()
      haptics.success()
      Alert.alert('Published!', 'Your video is live on your channel.')
    } catch (err: any) {
      console.error('[Studio] Upload failed:', err)
      Alert.alert('Upload failed', err.message || 'Failed to upload video')
    } finally {
      setUploading(false)
      setUploadProgress(0)
      setUploadSpeed(0)
      setUploadEta(0)
      setIsTranscoding(false)
    }
  }, [
    episodeMetadataEnabled,
    episodeNumber,
    expectedEpisodeCount,
    filePath,
    identity,
    loadVideos,
    mimeType,
    resetUploadForm,
    rpc,
    seasonNumber,
    selectedCategory,
    selectedVideo,
    seriesId,
    seriesTitle,
    thumbnailFilePath,
    thumbnailGenerating,
    thumbnailUri,
    title,
    tmdbSeriesId,
    uploadThumbnailForVideo,
    uploadVideo,
  ])

  const loadChannelDevices = useCallback(async () => {
    if (!rpc || !identity?.driveKey) return
    setChannelDevicesLoading(true)
    try {
      const res = await rpc.listDevices(identity.driveKey)
      setChannelDevices(res?.devices || [])
    } catch (err: unknown) {
      console.error('[Studio] Failed to load channel devices:', err instanceof Error ? err.message : err)
    } finally {
      setChannelDevicesLoading(false)
    }
  }, [rpc, identity?.driveKey])

  useEffect(() => { loadChannelDevices() }, [loadChannelDevices])

  const createChannelInvite = useCallback(async () => {
    await createStudioChannelInvite(rpc, identity?.driveKey, setChannelInviteCode, setChannelInviteLoading)
  }, [identity?.driveKey, rpc])

  const pairChannelDevice = useCallback(async () => {
    await pairStudioChannelDevice({
      rpc,
      code: channelPairCode,
      deviceName: channelPairName,
      setPairing: setChannelPairing,
      clearPairFields: () => {
        setChannelPairCode('')
        setChannelPairName('')
      },
      reloadDevices: loadChannelDevices,
    })
  }, [channelPairCode, channelPairName, loadChannelDevices, rpc])

  const shareChannelInvite = useCallback(async (code: string) => {
    await shareStudioChannelInvite(code)
  }, [])

  const myVideos = videos.filter((v) => v.channelKey === identity?.driveKey)

  const listHeaderComponent = (
    <View style={styles.headerBlock}>
      <Panel tone="muted" style={styles.statusStrip} testID="studio-publisher-status">
        <View style={styles.statusRow}>
          <Meta tone="muted" style={styles.statusKey}>SIGNER</Meta>
          <Meta tone="default" style={styles.statusVal}>{publisherSignerFact(identity)}</Meta>
        </View>
        <View style={styles.statusRow}>
          <Meta tone="muted" style={styles.statusKey}>CUSTODY</Meta>
          <Meta tone="default" style={styles.statusVal}>{publisherCustodyFact(identity)}</Meta>
        </View>
        <View style={styles.statusRow}>
          <Meta tone="muted" style={styles.statusKey}>DEVICE PAIRING</Meta>
          <Meta tone="default" style={styles.statusVal}>
            {publisherPairingFact(channelDevices, channelDevicesLoading)}
          </Meta>
        </View>
      </Panel>

      <View style={styles.section}>
        {selectedVideo ? (
          <StudioSelectedUploadForm
            thumbnailUri={thumbnailUri}
            thumbnailGenerating={thumbnailGenerating}
            thumbnailError={thumbnailError}
            onPickThumbnail={pickThumbnail}
            onClearSelection={clearVideoSelection}
            title={title}
            setTitle={setTitle}
            categoryOptions={categoryOptions}
            selectedCategory={selectedCategory}
            setSelectedCategory={setSelectedCategory}
            episodeMetadataEnabled={episodeMetadataEnabled}
            setEpisodeMetadataEnabled={setEpisodeMetadataEnabled}
            seriesId={seriesId}
            setSeriesId={setSeriesId}
            seriesTitle={seriesTitle}
            setSeriesTitle={setSeriesTitle}
            tmdbSeriesId={tmdbSeriesId}
            setTmdbSeriesId={setTmdbSeriesId}
            seasonNumber={seasonNumber}
            setSeasonNumber={setSeasonNumber}
            episodeNumber={episodeNumber}
            setEpisodeNumber={setEpisodeNumber}
            expectedEpisodeCount={expectedEpisodeCount}
            setExpectedEpisodeCount={setExpectedEpisodeCount}
            uploading={uploading}
            uploadProgress={uploadProgress}
            isTranscoding={isTranscoding}
            uploadSpeed={uploadSpeed}
            uploadEta={uploadEta}
            thumbnailFilePath={thumbnailFilePath}
            onUpload={handleUpload}
          />
        ) : (
          <StudioPickVideoButton
            pickingVideo={pickingVideo}
            preparingVideo={preparingVideo}
            onPress={pickVideo}
          />
        )}
      </View>

      <StudioChannelDevicesPanel
        channelDevices={channelDevices}
        channelDevicesLoading={channelDevicesLoading}
        channelInviteCode={channelInviteCode}
        channelInviteLoading={channelInviteLoading}
        channelPairCode={channelPairCode}
        setChannelPairCode={setChannelPairCode}
        channelPairName={channelPairName}
        setChannelPairName={setChannelPairName}
        channelPairing={channelPairing}
        hasDriveKey={!!identity?.driveKey}
        onCreateInvite={createChannelInvite}
        onShareInvite={shareChannelInvite}
        onPairDevice={pairChannelDevice}
      />

      <SectionHeader
        title={`PUBLISHED (${myVideos.length})`}
        flush
      />
    </View>

  )

  // Quietly assess immutable publication sources. The destructive operation
  // remains unavailable until the backend issues a fresh, evidence-bound nonce.
  useEffect(() => {
    const assess = rpc?.assessSourceOffload
    if (typeof assess !== 'function' || !identity?.driveKey) return
    const mine = videos.filter((v) => v.channelKey === identity.driveKey)
    let cancelled = false
    ;(async () => {
      for (const v of mine) {
        if (cancelled) return
        const publicationId = v.immutablePublication?.publicationId || v.publicationId
        if (!publicationId || assessedOffloadRef.current.has(publicationId)) continue
        assessedOffloadRef.current.add(publicationId)
        try {
          const res = await assess({ publicationId })
          if (cancelled) return
          setOffloadInfo((prev) => ({
            ...prev,
            [v.id]: offloadInfoFromAssessment(res),
          }))
        } catch {
          assessedOffloadRef.current.delete(publicationId)
        }
      }
    })()
    return () => { cancelled = true }
  }, [videos, identity?.driveKey, rpc])

  const handleOffloadVideo = useCallback(async (item: Video) => {
    const info = offloadInfo[item.id]
    if (!info) return
    await runStudioSourceOffload({
      item,
      info,
      rpc,
      assessedOffloadRef,
      setOffloadInfo,
    })
  }, [offloadInfo, rpc])

  const handleDeleteVideo = useCallback(async (videoId: string, videoTitle: string) => {
    await runDeleteStudioVideo({
      videoId,
      videoTitle,
      videos,
      removeVideo,
      rpc,
      driveKey: identity?.driveKey,
      loadVideos,
    })
  }, [identity?.driveKey, loadVideos, removeVideo, rpc, videos])

  const playPublishedVideo = useCallback(async (item: any) => {
    await playPublishedStudioVideo({
      item,
      rpc,
      identityDriveKey: identity?.driveKey,
      loadAndPlayVideo,
    })
  }, [identity?.driveKey, loadAndPlayVideo, rpc])


  const publisherEyebrow = `PUBLISHER / ${formatPublisherDeviceState(identity)}`


  return (
    <View style={styles.screen}>
      <StudioScreenHeader
        topInset={insets.top}
        hasIdentity={Boolean(identity)}
        publisherEyebrow={publisherEyebrow}
        onSearch={() => router.push('/search')}
        onSetupChannel={() => router.push('/profile')}
      />

      <FlatList
        data={myVideos}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={listHeaderComponent}
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingBottom: bottomPadding,
        }}
        ListEmptyComponent={
          <EmptyState
            icon="film"
            title="Nothing published yet"
            body="Pick a video above — it streams directly from your devices, no servers involved."
          />
        }
        ItemSeparatorComponent={() => <View style={styles.rowGap} />}
        renderItem={({ item }) => (
          <StudioPublishedVideoRow
            item={item}
            offload={offloadInfo[item.id]}
            onPlay={() => playPublishedVideo(item)}
            onEdit={() => setEditingVideo(item)}
            onOffload={() => handleOffloadVideo(item)}
            onDelete={() => handleDeleteVideo(item.id, item.title)}
          />
        )}
      />

      <VideoEditModal
        visible={!!editingVideo}
        video={editingVideo}
        channelKey={identity?.driveKey || ''}
        onClose={() => setEditingVideo(null)}
        onSaved={() => {
          setEditingVideo(null)
          if (identity?.driveKey) {
            loadVideos(identity.driveKey).catch(() => {})
          }
        }}
      />
    </View>
  )
}

function StudioInput({ style, ...props }: TextInputProps & { style?: StyleProp<TextStyle> }) {
  return (
    <TextInput
      placeholderTextColor={colors.textMuted}
      {...props}
      style={[styles.input, style]}
    />
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  setupBanner: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: borderWidth.rule,
    borderBottomColor: colors.border,
  },
  headerBlock: {
    paddingTop: spacing.lg,
  },
  statusStrip: {
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  statusKey: {
    ...fonts.caption.sm,
    color: colors.textMuted,
  },
  statusVal: {
    ...fonts.meta.sm,
    color: colors.text,
    textAlign: 'right',
    flexShrink: 1,
  },
  section: {
    paddingBottom: spacing.xl,
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: colors.borderSubtle,
    marginBottom: spacing.md,
  },
  uploadForm: {
    gap: spacing.lg,
  },
  thumbPanel: {
    overflow: 'hidden',
  },
  thumbAspect: {
    aspectRatio: 16 / 9,
    backgroundColor: colors.surface,
  },
  thumbFill: {
    width: '100%',
    height: '100%',
  },
  thumbScrim: {
    ...ABSOLUTE_FILL,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.overlayMedium,
  },
  thumbPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceHover,
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  thumbPlaceholderMeta: {
    textAlign: 'center',
  },
  thumbAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    backgroundColor: colors.surfaceHover,
    borderTopWidth: borderWidth.hairline,
    borderTopColor: colors.borderSubtle,
  },
  selectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  selectedIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedLabel: {
    flex: 1,
    ...fonts.title.md,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text,
  },
  fieldBlock: {
    gap: spacing.sm,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  episodeFields: {
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  episodeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  episodeInput: {
    flex: 1,
  },
  progressBlock: {
    gap: spacing.sm,
  },
  progressTrack: {
    height: 2,
    backgroundColor: colors.surfaceHover,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  progressMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  progressMeta: {
    flex: 1,
  },
  dropZone: {
    borderStyle: 'dashed',
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    alignItems: 'stretch',
    gap: spacing.md,
    paddingVertical: spacing.xl,
  },
  dropHint: {
    marginBottom: spacing.xs,
  },
  devicesPanel: {
    gap: spacing.md,
  },
  devicesBlurb: {
    marginBottom: spacing.md,
  },
  deviceList: {
    gap: spacing.sm,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: colors.borderSubtle,
  },
  deviceCopy: {
    flex: 1,
    gap: 2,
  },
  deviceName: {
    ...fonts.title.md,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text,
  },
  inviteBox: {
    gap: spacing.sm,
  },
  inviteCode: {
    ...fonts.meta.md,
    color: colors.text,
  },
  inviteActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  inviteBtn: {
    flex: 1,
  },
  input: {
    backgroundColor: colors.surfaceHover,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    color: colors.text,
    ...fonts.body.md,
  },
  rowGap: {
    height: spacing.md,
  },
  publishedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 72,
  },
  publishedHit: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  publishedThumb: {
    width: 96,
    height: 54,
    backgroundColor: colors.surfaceHover,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
    borderRadius: radius.card,
    marginLeft: spacing.sm,
    marginVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  publishedThumbImg: {
    width: '100%',
    height: '100%',
  },
  publishedCopy: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 4,
  },
  publishedTitle: {
    ...fonts.title.md,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text,
  },
  publishedActionSlot: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
})

export default function DeveloperStudioScreen() {
  return <DeveloperModeGate><StudioScreen /></DeveloperModeGate>
}
