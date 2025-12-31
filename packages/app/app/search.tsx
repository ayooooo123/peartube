/**
 * Search Results Page - Global semantic search across all channels
 */
import { useCallback, useState, useEffect } from 'react'
import { View, Text, ActivityIndicator, ScrollView, useWindowDimensions, Platform, Pressable, TextInput } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { Feather } from '@expo/vector-icons'
import { useApp, colors } from './_layout'
import { VideoCard, VideoData } from '../components/video'
import { CastHeaderButton } from '@/components/cast'
import { useVideoPlayerContext } from '@/lib/VideoPlayerContext'
import { usePlatform } from '@/lib/PlatformProvider'

// Detect Pear desktop vs mobile (must match index.web.tsx detection)
const isPear = Platform.OS === 'web' && typeof window !== 'undefined' && !!(window as any).Pear

export default function SearchScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const params = useLocalSearchParams<{ q?: string }>()
  const query = typeof params.q === 'string' ? params.q : ''
  const [queryInput, setQueryInput] = useState(query)

  const { ready, rpc, platformEvents } = useApp()
  const { loadAndPlayVideo, closeVideo } = useVideoPlayerContext()
  const { isDesktop } = usePlatform()
  const { width: screenWidth } = useWindowDimensions()

  // Calculate video grid columns for desktop
  const getGridColumns = () => {
    if (!isDesktop) return 1
    if (screenWidth >= 1400) return 4
    if (screenWidth >= 1100) return 3
    if (screenWidth >= 800) return 2
    return 1
  }
  const gridColumns = getGridColumns()

  // State
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<VideoData[]>([])
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)

  // On Pear desktop, clear any active watch hash so background playback stops.
  useEffect(() => {
    if (!isPear || typeof window === 'undefined') return
    closeVideo()
    if (window.location.hash.startsWith('#/watch')) {
      window.location.hash = ''
    }
  }, [closeVideo])

  useEffect(() => {
    setQueryInput(query)
  }, [query])

  const submitSearch = useCallback(() => {
    const nextQuery = queryInput.trim()
    if (!nextQuery) return
    router.replace({ pathname: '/search', params: { q: nextQuery } })
  }, [queryInput, router])

  // Search when query changes
  useEffect(() => {
    if (!query || !ready || !rpc) return

    const doSearch = async () => {
      setSearching(true)
      setError(null)
      setSearched(true)

      try {
        console.log('[Search] Searching for:', query)
        console.log('[Search] rpc.globalSearchVideos:', typeof rpc.globalSearchVideos)
        if (typeof rpc.globalSearchVideos !== 'function') {
          throw new Error('globalSearchVideos method not available on rpc')
        }
        console.log('[Search] Calling globalSearchVideos...')
        const res = await rpc.globalSearchVideos({ query, topK: 50 })
        console.log('[Search] Got response:', res)
        console.log('[Search] Results:', res?.results?.length || 0)

        // Convert search results to VideoData format
        // Note: metadata can be JSON string from RPC or already parsed object
        console.log('[Search] Raw results:', res.results)
        const videos: VideoData[] = (res.results || []).map((r: any, idx: number) => {
          console.log('[Search] Processing result', idx, ':', r)
          console.log('[Search] r.metadata type:', typeof r.metadata, 'value:', r.metadata)
          console.log('[Search] r.channelKey:', r.channelKey)
          try {
            // Handle metadata as either string (RPC serialized) or object
            const metadata = typeof r.metadata === 'string'
              ? JSON.parse(r.metadata)
              : (r.metadata || {})
            console.log('[Search] Parsed metadata:', metadata)

            const score = typeof r.score === 'string' ? parseFloat(r.score) : (r.score || undefined)

            // Try multiple possible key names for channelKey
            const channelKey = metadata.channelKey || metadata.driveKey || r.channelKey || r.driveKey
            console.log('[Search] Extracted channelKey:', channelKey)

            const video = {
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
            console.log('[Search] Parsed video:', video.title, 'channelKey:', video.channelKey)
            return video
          } catch (parseErr) {
            console.error('[Search] Failed to parse result:', parseErr, r)
            return null
          }
        }).filter(Boolean) as VideoData[]

        console.log('[Search] Final videos array:', videos.length, videos)
        setResults(videos)
      } catch (e: any) {
        console.error('[Search] Error:', e)
        setError(e?.message || 'Search failed')
        setResults([])
      } finally {
        setSearching(false)
      }
    }

    doSearch()
  }, [query, ready, rpc])

  // Handle video click - match the homepage behavior per platform.
  const handleVideoPress = useCallback(async (video: VideoData) => {
    console.log('[Search] handleVideoPress called with:', video)
    // Ensure channelKey is set (search results may have it in driveKey)
    const channelKey = video.channelKey || video.driveKey
    console.log('[Search] Using channelKey:', channelKey)
    if (!channelKey) {
      console.error('[Search] Cannot play video - missing channelKey:', video)
      return
    }

    // Pear desktop: use the same hash watch route as the homepage.
    if (isPear && typeof window !== 'undefined') {
      console.log('[Search] isPear detected, using hash routing')

      // First, close any existing video and wait for state to propagate
      closeVideo()

      const setWatchHash = () => {
        console.log('[Search] Setting hash to watch:', channelKey, video.id)
        window.location.hash = `/watch/${channelKey}/${video.id}`
      }

      const ensureHome = () => {
        const path = window.location.pathname.replace(/\/+$/, '') || '/'
        if (path !== '/') {
          router.replace('/')
        }
      }

      if (typeof (router as any).canGoBack === 'function' && (router as any).canGoBack()) {
        router.back()
        setTimeout(() => {
          ensureHome()
          setTimeout(setWatchHash, 50)
        }, 0)
      } else {
        ensureHome()
        setTimeout(setWatchHash, 50)
      }
      return
    }

    // Web static export: mirror homepage navigation to the video HTML page.
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const base = window.location.href.split('#')[0].replace(/index\.html$/, '')
      const videoData = encodeURIComponent(JSON.stringify({ ...video, channelKey }))
      window.location.href = `${base}video/${video.id}.html?videoData=${videoData}`
      return
    }

    if (!rpc) {
      console.error('[Search] Cannot play video - rpc not ready')
      return
    }

    try {
      const videoRef = (video.path && typeof video.path === 'string' && video.path.startsWith('/'))
        ? video.path
        : video.id
      console.log('[Search] Using videoRef:', videoRef)

      const result = await rpc.getVideoUrl({
        channelKey,
        videoId: videoRef,
        publicBeeKey: video.publicBeeKey || undefined
      })
      console.log('[Search] getVideoUrl result:', result)

      if (result?.url) {
        console.log('[Search] Playing video with url:', result.url)
        // Pass video with channelKey guaranteed to be set
        loadAndPlayVideo({ ...video, channelKey }, result.url)
      } else {
        console.error('[Search] No url in result:', result)
      }
    } catch (err) {
      console.error('[Search] Failed to play video:', err)
    }
  }, [rpc, loadAndPlayVideo, closeVideo, router])

  // Back button handler
  const handleBack = useCallback(() => {
    router.back()
  }, [router])

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: isDesktop ? 0 : insets.top }}>
      {/* Header */}
      {!isDesktop && (
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}>
          <Pressable onPress={handleBack} style={{ marginRight: 16 }}>
            <Feather name="arrow-left" size={24} color={colors.text} />
          </Pressable>
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', flex: 1 }} numberOfLines={1}>
            Search: {query}
          </Text>
          <CastHeaderButton size={18} />
        </View>
      )}

      {/* Desktop shows query in content area */}
      {isDesktop && (
        <View style={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 8 }}>
          <Text style={{ color: colors.text, fontSize: 24, fontWeight: '600' }}>
            Search results for "{query}"
          </Text>
        </View>
      )}

      {/* Content */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: isDesktop ? 24 : 16,
          paddingTop: isDesktop ? 16 : 16,
        }}
      >
        {/* Search input */}
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          marginBottom: 16
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
            paddingVertical: Platform.OS === 'web' ? 8 : 10,
          }}>
            <Feather name="search" size={16} color={colors.textMuted} />
            <TextInput
              value={queryInput}
              onChangeText={setQueryInput}
              placeholder="Search videos..."
              placeholderTextColor={colors.textMuted}
              style={{ flex: 1, color: colors.text, marginLeft: 8 }}
              autoCapitalize="none"
              returnKeyType="search"
              onSubmitEditing={submitSearch}
            />
          </View>
          <Pressable
            onPress={submitSearch}
            disabled={!queryInput.trim() || searching}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 10,
              borderRadius: 12,
              backgroundColor: colors.primary,
              opacity: (!queryInput.trim() || searching) ? 0.5 : 1,
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>{searching ? '…' : 'Search'}</Text>
          </Pressable>
        </View>

        {/* Loading state */}
        {searching && (
          <View style={{ alignItems: 'center', paddingVertical: 48 }}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={{ color: colors.textSecondary, marginTop: 16 }}>
              Searching across all channels...
            </Text>
          </View>
        )}

        {/* Error state */}
        {error && !searching && (
          <View style={{ alignItems: 'center', paddingVertical: 48 }}>
            <Feather name="alert-circle" size={48} color={colors.error} />
            <Text style={{ color: colors.error, marginTop: 16, textAlign: 'center' }}>
              {error}
            </Text>
          </View>
        )}

        {/* Empty state */}
        {!searching && searched && results.length === 0 && !error && (
          <View style={{ alignItems: 'center', paddingVertical: 48 }}>
            <Feather name="search" size={48} color={colors.textSecondary} />
            <Text style={{ color: colors.textSecondary, marginTop: 16, textAlign: 'center' }}>
              No results found for "{query}"
            </Text>
            <Text style={{ color: colors.textSecondary, marginTop: 8, textAlign: 'center', fontSize: 13 }}>
              Try a different search term or wait for more channels to be indexed
            </Text>
          </View>
        )}

        {/* Results grid */}
        {!searching && results.length > 0 && (
          <>
            <Text style={{ color: colors.textSecondary, marginBottom: 16, fontSize: 14 }}>
              Found {results.length} result{results.length !== 1 ? 's' : ''}
            </Text>

            <View style={isDesktop ? {
              flexDirection: 'row',
              flexWrap: 'wrap',
              marginHorizontal: -8,
            } : {}}>
              {results.map((video, index) => (
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
                    video={video}
                    onPress={() => handleVideoPress(video)}
                    showChannelInfo={true}
                  />
                  {/* Show relevance score for debugging */}
                  {video.score !== undefined && (
                    <Text style={{
                      color: colors.textSecondary,
                      fontSize: 11,
                      marginTop: 4,
                      opacity: 0.6,
                    }}>
                      Relevance: {(video.score * 100).toFixed(1)}%
                    </Text>
                  )}
                </View>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  )
}
