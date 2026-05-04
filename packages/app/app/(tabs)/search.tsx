import { useCallback, useState, useEffect, useRef } from 'react'
import { View, Text, ActivityIndicator, ScrollView, useWindowDimensions, Platform, Pressable, TextInput } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams } from 'expo-router'
import { Feather } from '@expo/vector-icons'
import { useApp, colors } from '../_layout'
import { VideoCard, type VideoData } from '../../components/video'
import type { VideoData as CoreVideoData } from '@peartube/core'
import { CastHeaderButton } from '@/components/cast'
import { useVideoPlayerContext } from '@/lib/VideoPlayerContext'
import { usePlatform } from '@/lib/PlatformProvider'
import { useTabBarMetrics } from '@/lib/tabBarHeight'
import { fetchThumbnailUrlWithRetry } from '@/lib/thumbnail'
import { getDesktopVideoGridColumns } from '@/lib/video-layout'

const isPear = Platform.OS === 'web' && typeof window !== 'undefined' && (!!(window as any).Pear || !!(window as any).bridge)

function computeTextRelevance(query: string, title: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[._\-\[\]\(\)]/g, ' ').replace(/\s+/g, ' ').trim()
  const q = normalize(query)
  const t = normalize(title)

  if (t === q) return 3
  if (t.includes(q)) return 2

  const qWords = q.split(' ').filter(w => w.length > 1)
  if (qWords.length === 0) return 0
  const matchCount = qWords.filter(w => t.includes(w)).length
  return matchCount / qWords.length
}

export default function SearchTab() {
  const insets = useSafeAreaInsets()
  const tabBarMetrics = useTabBarMetrics()
  const inputRef = useRef<TextInput>(null)
  const params = useLocalSearchParams<{ q?: string }>()
  
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')

  const { ready, rpc, blobServerPort } = useApp()
  const { loadAndPlayVideo, closeVideo } = useVideoPlayerContext()
  const { isDesktop } = usePlatform()
  const { width: screenWidth } = useWindowDimensions()

  useEffect(() => {
    if (typeof params.q === 'string' && params.q.trim()) {
      setQueryInput(params.q)
      setQuery(params.q)
      setSearched(true)
    }
  }, [params.q])

  const gridColumns = getDesktopVideoGridColumns(isDesktop, screenWidth)

  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<VideoData[]>([])
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [thumbnailCache, setThumbnailCache] = useState<Record<string, string>>({})
  const thumbnailCacheRef = useRef(thumbnailCache)
  thumbnailCacheRef.current = thumbnailCache
  const inflightThumbnailFetches = useRef<Set<string>>(new Set())

  const submitSearch = useCallback(() => {
    const nextQuery = queryInput.trim()
    if (!nextQuery) return
    setQuery(nextQuery)
    setSearched(true)
  }, [queryInput])

  const clearSearch = useCallback(() => {
    setQueryInput('')
    setQuery('')
    setResults([])
    setSearched(false)
    setError(null)
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!query || !ready || !rpc) return

    const doSearch = async () => {
      setSearching(true)
      setError(null)

      try {
        if (typeof rpc.globalSearchVideos !== 'function') {
          throw new Error('Search not available')
        }
        const res = await rpc.globalSearchVideos({ query, topK: 50 })

        const videos: VideoData[] = (res.results || []).map((r: any) => {
          try {
            const metadata = typeof r.metadata === 'string'
              ? JSON.parse(r.metadata)
              : (r.metadata || {})

            const score = typeof r.score === 'string' ? parseFloat(r.score) : (r.score || undefined)
            const channelKey = metadata.channelKey || metadata.driveKey || r.channelKey || r.driveKey

            return {
              id: r.id || metadata.videoId,
              title: metadata.title || 'Untitled',
              description: metadata.description || '',
              duration: metadata.duration,
              thumbnail: metadata.thumbnail,
              category: metadata.category,
              createdAt: metadata.createdAt,
              size: metadata.size,
              driveKey: channelKey,
              channelKey: channelKey,
              publicBeeKey: metadata.publicBeeKey || r.publicBeeKey,
              score,
            }
          } catch {
            return null
          }
        }).filter(Boolean) as VideoData[]

        videos.sort((a, b) => {
          const relA = computeTextRelevance(query, a.title || '')
          const relB = computeTextRelevance(query, b.title || '')
          if (relA !== relB) return relB - relA
          return (b.score ?? 0) - (a.score ?? 0)
        })

        setResults(videos)

        for (const v of videos) {
          const ck = v.channelKey || v.driveKey
          if (!ck || !v.id) continue
          const cacheKey = `${ck}:${v.id}`
          if (thumbnailCacheRef.current[cacheKey]) continue
          if (inflightThumbnailFetches.current.has(cacheKey)) continue
          inflightThumbnailFetches.current.add(cacheKey)

          void fetchThumbnailUrlWithRetry({
            rpc,
            channelKey: ck,
            videoId: v.id,
            expectedPort: blobServerPort,
          }).then((url) => {
            if (!url) return
            setThumbnailCache(prev => {
              if (prev[cacheKey] === url) return prev
              return { ...prev, [cacheKey]: url }
            })
          }).catch(() => {}).finally(() => {
            inflightThumbnailFetches.current.delete(cacheKey)
          })
        }
      } catch (e: any) {
        setError(e?.message || 'Search failed')
        setResults([])
      } finally {
        setSearching(false)
      }
    }

    doSearch()
  }, [query, ready, rpc, blobServerPort])

  const handleVideoPress = useCallback(async (video: VideoData) => {
    const channelKey = video.channelKey || video.driveKey
    if (!channelKey) return

    if (isPear && typeof window !== 'undefined') {
      closeVideo()
      setTimeout(() => {
        window.location.hash = `/watch/${encodeURIComponent(channelKey)}/${encodeURIComponent(video.id)}`
      }, 50)
      return
    }

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const base = window.location.href.split('#')[0].replace(/index\.html$/, '')
      const videoData = encodeURIComponent(JSON.stringify({ ...video, channelKey }))
      window.location.href = `${base}video/${video.id}.html?videoData=${videoData}`
      return
    }

    if (!rpc) return

    try {
      const videoRef = video.id
      const videoAny = video as VideoData & { blobId?: string | null; blobsCoreKey?: string | null }
      const result = await rpc.preparePlayback({
        channelKey,
        videoId: videoRef,
        publicBeeKey: video.publicBeeKey || undefined,
        blobId: videoAny.blobId || undefined,
        blobsCoreKey: videoAny.blobsCoreKey || undefined,
        mimeType: video.mimeType || undefined,
      })

      if (result?.url) {
        const coreVideo: CoreVideoData = { 
          id: video.id,
          title: video.title,
          channelKey,
          description: video.description || '',
          path: video.path || video.id,
          size: video.size || 0,
          uploadedAt: video.uploadedAt || Date.now(),
          thumbnail: video.thumbnail ?? undefined,
          duration: video.duration,
          category: video.category,
          channel: video.channel ? { name: video.channel.name } : undefined,
          thumbnailUrl: video.thumbnailUrl,
        }
        loadAndPlayVideo(coreVideo, result.url)
      }
    } catch (err) {
      console.error('[Search] Failed to play video:', err)
    }
  }, [rpc, loadAndPlayVideo, closeVideo])

  const bottomPadding = Platform.OS !== 'web' ? tabBarMetrics.height + 16 : 16

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: 16,
          paddingBottom: bottomPadding,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {!isDesktop && (
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            marginBottom: 24
          }}>
            <View style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.bgSecondary,
              borderRadius: 12,
              paddingHorizontal: 12,
              paddingVertical: Platform.OS === 'web' ? 8 : 12,
            }}>
              <Feather name="search" size={18} color={colors.textMuted} />
              <TextInput
                ref={inputRef}
                value={queryInput}
                onChangeText={setQueryInput}
                placeholder="Search videos..."
                placeholderTextColor={colors.textMuted}
                style={{ 
                  flex: 1, 
                  color: colors.text, 
                  marginLeft: 10,
                  fontSize: 16,
                }}
                autoCapitalize="none"
                returnKeyType="search"
                onSubmitEditing={submitSearch}
              />
              {queryInput.length > 0 && (
                <Pressable onPress={clearSearch} hitSlop={8}>
                  <Feather name="x" size={18} color={colors.textMuted} />
                </Pressable>
              )}
            </View>
            <Pressable
              onPress={submitSearch}
              disabled={!queryInput.trim() || searching}
              style={{
                paddingHorizontal: 16,
                paddingVertical: 12,
                borderRadius: 12,
                backgroundColor: colors.primary,
                opacity: (!queryInput.trim() || searching) ? 0.5 : 1,
              }}
            >
              <Text style={{ color: '#fff', fontWeight: '600', fontSize: 15 }}>
                {searching ? '…' : 'Search'}
              </Text>
            </Pressable>
          </View>
        )}

        {!searched && !searching && (
          <View style={{ alignItems: 'center', paddingVertical: 64 }}>
            <View style={{
              width: 80,
              height: 80,
              borderRadius: 40,
              backgroundColor: colors.bgHover,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 20,
            }}>
              <Feather name="search" size={36} color={colors.textMuted} />
            </View>
            <Text style={{ 
              color: colors.text, 
              fontSize: 18, 
              fontWeight: '600',
              marginBottom: 8,
            }}>
              Search PearTube
            </Text>
            <Text style={{ 
              color: colors.textMuted, 
              fontSize: 14, 
              textAlign: 'center',
              paddingHorizontal: 32,
            }}>
              Find videos across all channels in the network
            </Text>
          </View>
        )}

        {searching && (
          <View style={{ alignItems: 'center', paddingVertical: 48 }}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={{ color: colors.textSecondary, marginTop: 16 }}>
              Searching...
            </Text>
          </View>
        )}

        {error && !searching && (
          <View style={{ alignItems: 'center', paddingVertical: 48 }}>
            <Feather name="alert-circle" size={48} color={colors.error} />
            <Text style={{ color: colors.error, marginTop: 16, textAlign: 'center' }}>
              {error}
            </Text>
          </View>
        )}

        {!searching && searched && results.length === 0 && !error && (
          <View style={{ alignItems: 'center', paddingVertical: 48 }}>
            <Feather name="search" size={48} color={colors.textSecondary} />
            <Text style={{ color: colors.textSecondary, marginTop: 16, textAlign: 'center' }}>
              No results found for "{query}"
            </Text>
            <Text style={{ color: colors.textMuted, marginTop: 8, textAlign: 'center', fontSize: 13 }}>
              Try a different search term
            </Text>
          </View>
        )}

        {!searching && results.length > 0 && (
          <>
            <Text style={{ color: colors.textSecondary, marginBottom: 16, fontSize: 14 }}>
              Found {results.length} result{results.length !== 1 ? 's' : ''} for "{query}"
            </Text>

            <View style={isDesktop ? {
              flexDirection: 'row',
              flexWrap: 'wrap',
              marginHorizontal: -8,
            } : {}}>
              {results.map((video, index) => {
                const ck = video.channelKey || video.driveKey
                const thumbUrl = (ck ? thumbnailCache[`${ck}:${video.id}`] : null) || video.thumbnailUrl || video.thumbnail || undefined
                const videoWithThumb = thumbUrl ? { ...video, thumbnailUrl: thumbUrl } : video
                return (
                <View
                  key={`${video.driveKey || video.channelKey}-${video.id}-${index}`}
                  style={isDesktop ? {
                    width: `${100 / gridColumns}%`,
                    paddingHorizontal: 8,
                    marginBottom: 24,
                  } : {
                    marginBottom: 16,
                  }}
                >
                  <VideoCard
                    video={videoWithThumb}
                    onPress={() => handleVideoPress(video)}
                    showChannelInfo={true}
                  />
                </View>
              )})}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  )
}
