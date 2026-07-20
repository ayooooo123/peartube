import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator } from 'react-native'
import { useApp, colors } from '../_layout'
import { formatTimeAgo, formatContentBadge } from '@/lib/formatters'
import { withChannelPageTimeout } from '@/lib/channel-page'
import { fetchThumbnailUrlWithRetry } from '@/lib/thumbnail'
import { createChannelCatalogState } from '@/lib/channel-catalog-state.js'
import { createChannelPlaybackPayload, stageWebChannelPlayback } from '@/lib/channel-playback-handoff.js'
import { CHANNEL_ARTWORK_RESOLUTION_MS, resolveArtworkCandidates } from '@/lib/channel-artwork.js'

type ChannelProfile = {
  name?: string
  description?: string | null
}

type VideoItem = {
  id: string
  title?: string
  sourcePublishedAt?: number
  originalAirDate?: number
  thumbnailUrl?: string | null
  thumbnailBlobId?: string | null
  thumbnailBlobsCoreKey?: string | null
  thumbnailMimeType?: string | null
  blobId?: string | null
  blobsCoreKey?: string | null
  mimeType?: string | null
  publicBeeKey?: string | null
  contentKind?: string | null
  seasonNumber?: number | null
  episodeNumber?: number | null
}

type ArtworkCandidate =
  | { kind: 'blob'; role: string; blobId: string; blobsCoreKey: string; mimeType: string | null }
  | { kind: 'remote'; role: string; url: string }

type CatalogCard = {
  id: string
  item: VideoItem
  artworkCandidates: ArtworkCandidate[]
}

// TV channels render "Season N" sections (episodes ascending); everything else
// stays a single unlabeled grid, byte-identical to the previous layout.
export function groupCardsIntoSections (cards: CatalogCard[]): Array<{ label: string | null; cards: CatalogCard[] }> {
  const isEpisode = (card: CatalogCard) =>
    card.item?.contentKind === 'episode' &&
    Number(card.item?.seasonNumber) > 0 &&
    Number(card.item?.episodeNumber) > 0
  const episodes = cards.filter(isEpisode)
  if (episodes.length === 0) return [{ label: null, cards }]

  const rest = cards.filter((card) => !isEpisode(card))
  const bySeason = new Map<number, CatalogCard[]>()
  for (const card of episodes) {
    const season = Number(card.item.seasonNumber)
    const list = bySeason.get(season) || []
    list.push(card)
    bySeason.set(season, list)
  }
  const sections: Array<{ label: string | null; cards: CatalogCard[] }> = [...bySeason.keys()].sort((a, b) => a - b).map((season) => ({
    label: `Season ${season}`,
    cards: (bySeason.get(season) || []).sort((a, b) => Number(a.item.episodeNumber) - Number(b.item.episodeNumber))
  }))
  if (rest.length > 0) sections.push({ label: null, cards: rest })
  return sections
}
type ArtworkResolution = {
  url: string | null
  nextIndex: number
  provisional: boolean
  failedUrls: string[]
}


type CatalogTab = {
  id: string
  label: string
  sectionLabel: string
  itemCount: number
}

type CatalogView = {
  profile: ChannelProfile | null
  badge: string | null
  tabs: CatalogTab[]
  profileArtwork: {
    avatar: ArtworkCandidate[]
    banner: ArtworkCandidate[]
    card: ArtworkCandidate[]
  }
}

type GroupPageState = {
  cards: CatalogCard[]
  nextCursor: string | null
  loaded: boolean
  loading: boolean
  loadingMore: boolean
  error: string
}

type PickedAvatar = {
  filePath: string
  dataUrl?: string
  mimeType?: string
}

type ChannelRouteParams = {
  channelKey: string
  publicBeeKey: string
}

type ChannelPageProps = {
  channelKey?: string
  publicBeeKey?: string
  params?: {
    key?: string
    publicBeeKey?: string
  }
}

function parseChannelKeyFromHash(hash: string): ChannelRouteParams {
  const normalized = hash.replace(/^#\/?/, '')
  const [pathPart = '', queryPart = ''] = normalized.split('?')
  const parts = pathPart.split('/').filter(Boolean)
  const params = new URLSearchParams(queryPart)
  return {
    channelKey: parts[0] === 'channel' && parts[1] ? safeDecodeURIComponent(parts[1]) : '',
    publicBeeKey: safeDecodeURIComponent(params.get('publicBeeKey') || ''),
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

type CatalogStateSnapshot = {
  catalog: CatalogView | null
  selectedGroupId: string
  pages: Record<string, GroupPageState>
  catalogLoading: boolean
  catalogError: string
}

const EMPTY_GROUP_PAGE: GroupPageState = {
  cards: [],
  nextCursor: null,
  loaded: false,
  loading: false,
  loadingMore: false,
  error: '',
}

const INITIAL_CATALOG_STATE: CatalogStateSnapshot = {
  catalog: null,
  selectedGroupId: '',
  pages: {},
  catalogLoading: true,
  catalogError: '',
}


export default function ChannelPageWeb(props: ChannelPageProps) {
  const { rpc, identity, blobServerPort } = useApp()
  const propChannelKey = props.channelKey || props.params?.key || ''
  const propPublicBeeKey = props.publicBeeKey || props.params?.publicBeeKey || ''

  const initialRouteParams = useMemo(() => {
    if (propChannelKey) return { channelKey: propChannelKey, publicBeeKey: propPublicBeeKey }
    if (typeof window === 'undefined') return { channelKey: '', publicBeeKey: '' }
    return parseChannelKeyFromHash(window.location.hash)
  }, [propChannelKey, propPublicBeeKey])

  const [resolvedChannelKey, setResolvedChannelKey] = useState<string>(initialRouteParams.channelKey)
  const [resolvedPublicBeeKey, setResolvedPublicBeeKey] = useState<string>(initialRouteParams.publicBeeKey)
  const [error, setError] = useState<string | null>(null)
  const [catalogState, setCatalogState] = useState<CatalogStateSnapshot>(INITIAL_CATALOG_STATE)
  const catalogController = useMemo(() => createChannelCatalogState({
    rpc,
    bound: withChannelPageTimeout,
    onChange: (nextState: CatalogStateSnapshot) => setCatalogState(nextState),
  }), [rpc])
  const [thumbnailCache, setThumbnailCache] = useState<Record<string, ArtworkResolution>>({})
  const thumbnailCacheRef = useRef<Record<string, ArtworkResolution>>({})
  const [profileArtworkCache, setProfileArtworkCache] = useState<Record<string, ArtworkResolution>>({})
  const profileArtworkCacheRef = useRef<Record<string, ArtworkResolution>>({})

  const thumbnailRequestGeneration = useRef(0)
  const profileArtworkRequestGeneration = useRef(0)
  const thumbnailAttempt = useRef<Record<string, number>>({})
  const profileArtworkAttempt = useRef<Record<string, number>>({})

  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [pickedAvatar, setPickedAvatar] = useState<PickedAvatar | null>(null)
  const [pickAvatarLoading, setPickAvatarLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const catalogView = catalogState.catalog
  const channelProfile = catalogView?.profile || null
  const selectedGroupId = catalogState.selectedGroupId
  const selectedTab = catalogView?.tabs.find((tab) => tab.id === selectedGroupId) || null
  const selectedPage = catalogState.pages[selectedGroupId] || EMPTY_GROUP_PAGE
  const channelName = channelProfile?.name?.trim() || `Channel ${resolvedChannelKey.slice(0, 8) || 'Unknown'}`
  const channelDescription = channelProfile?.description?.trim() || 'No description yet.'
  const avatarSrc = pickedAvatar?.dataUrl || profileArtworkCache.avatar?.url || ''
  const bannerSrc = profileArtworkCache.banner?.url || ''

  useEffect(() => {
    if (propChannelKey) {
      setResolvedChannelKey(propChannelKey)
      setResolvedPublicBeeKey(propPublicBeeKey)
      return
    }
    if (typeof window === 'undefined') return

    const updateKey = () => {
      const routeParams = parseChannelKeyFromHash(window.location.hash)
      setResolvedChannelKey(routeParams.channelKey)
      setResolvedPublicBeeKey(routeParams.publicBeeKey)
    }
    updateKey()
    window.addEventListener('hashchange', updateKey)
    return () => window.removeEventListener('hashchange', updateKey)
  }, [propChannelKey, propPublicBeeKey])

  const loadChannelData = useCallback(() => {
    setError(null)
    thumbnailCacheRef.current = {}
    setThumbnailCache({})
    setProfileArtworkCache({})
    profileArtworkCacheRef.current = {}
    thumbnailAttempt.current = {}
    profileArtworkAttempt.current = {}
    setPickedAvatar(null)
    thumbnailRequestGeneration.current += 1
    profileArtworkRequestGeneration.current += 1
    return catalogController.loadCatalog({
      channelKey: resolvedChannelKey,
      publicBeeKey: resolvedPublicBeeKey,
    })
  }, [catalogController, resolvedChannelKey, resolvedPublicBeeKey])

  useEffect(() => {
    void loadChannelData()
    return () => {
      catalogController.dispose()
      thumbnailRequestGeneration.current += 1
      profileArtworkRequestGeneration.current += 1
    }
  }, [catalogController, loadChannelData])
  const resolveCardArtwork = useCallback((
    card: CatalogCard,
    startIndex = 0,
    initialProvisional = false,
    failedUrls: string[] = [],
  ) => {
    const cacheKey = `${resolvedChannelKey}:${card.id}`
    const requestGeneration = thumbnailRequestGeneration.current
    const attempt = (thumbnailAttempt.current[cacheKey] || 0) + 1
    thumbnailAttempt.current[cacheKey] = attempt
    return resolveArtworkCandidates(
      card.artworkCandidates,
      (candidate: Extract<ArtworkCandidate, { kind: 'blob' }>) => {
        if (!rpc) return null
        return fetchThumbnailUrlWithRetry({
          rpc,
          channelKey: resolvedChannelKey,
          videoId: card.id,
          expectedPort: blobServerPort,
          blobRefs: {
            thumbnailBlobId: candidate.blobId,
            thumbnailBlobsCoreKey: candidate.blobsCoreKey,
            thumbnailMimeType: candidate.mimeType,
          },
        })
      },
      {
        deadline: Date.now() + CHANNEL_ARTWORK_RESOLUTION_MS,
        startIndex,
        initialProvisional,
        blobResolverAvailable: Boolean(rpc),
        failedUrls,
      },
    ).then((resolution) => {
      if (
        !resolution ||
        requestGeneration !== thumbnailRequestGeneration.current ||
        thumbnailAttempt.current[cacheKey] !== attempt
      ) return
      setThumbnailCache((previous) => {
        const next = { ...previous, [cacheKey]: resolution }
        thumbnailCacheRef.current = next
        return next
      })
    })
  }, [blobServerPort, resolvedChannelKey, rpc])

  useEffect(() => {
    if (!resolvedChannelKey || selectedPage.cards.length === 0) return
    const requestGeneration = ++thumbnailRequestGeneration.current

    for (const card of selectedPage.cards) {
      const current = thumbnailCacheRef.current[`${resolvedChannelKey}:${card.id}`]
      if (current && !(current.provisional && rpc)) continue
      void resolveCardArtwork(card, 0, false, current?.failedUrls || [])
    }

    return () => {
      if (thumbnailRequestGeneration.current === requestGeneration) {
        thumbnailRequestGeneration.current += 1
      }
    }
  }, [resolvedChannelKey, resolveCardArtwork, rpc, selectedPage.cards])

  const resolveProfileArtwork = useCallback((
    placement: 'avatar' | 'banner',
    startIndex = 0,
    initialProvisional = false,
    failedUrls: string[] = [],
  ) => {
    const candidates = catalogView?.profileArtwork[placement]
    if (!candidates) return Promise.resolve()
    const requestGeneration = profileArtworkRequestGeneration.current
    const attempt = (profileArtworkAttempt.current[placement] || 0) + 1
    profileArtworkAttempt.current[placement] = attempt
    return resolveArtworkCandidates(
      candidates,
      (candidate: Extract<ArtworkCandidate, { kind: 'blob' }>) => {
        if (!rpc) return null
        return fetchThumbnailUrlWithRetry({
          rpc,
          channelKey: resolvedChannelKey,
          videoId: `profile:${placement}`,
          expectedPort: blobServerPort,
          blobRefs: {
            thumbnailBlobId: candidate.blobId,
            thumbnailBlobsCoreKey: candidate.blobsCoreKey,
            thumbnailMimeType: candidate.mimeType,
          },
        })
      },
      {
        deadline: Date.now() + CHANNEL_ARTWORK_RESOLUTION_MS,
        startIndex,
        initialProvisional,
        blobResolverAvailable: Boolean(rpc),
        failedUrls,
      },
    ).then((resolution) => {
      if (
        !resolution ||
        requestGeneration !== profileArtworkRequestGeneration.current ||
        profileArtworkAttempt.current[placement] !== attempt
      ) return
      setProfileArtworkCache((previous) => {
        const next = { ...previous, [placement]: resolution }
        profileArtworkCacheRef.current = next
        return next
      })
    })
  }, [blobServerPort, catalogView, resolvedChannelKey, rpc])

  useEffect(() => {
    if (!resolvedChannelKey || !catalogView) return
    const requestGeneration = ++profileArtworkRequestGeneration.current

    for (const placement of ['avatar', 'banner'] as const) {
      const current = profileArtworkCacheRef.current[placement]
      if (current && !(current.provisional && rpc)) continue
      void resolveProfileArtwork(placement, 0, false, current?.failedUrls || [])
    }
    return () => {
      if (profileArtworkRequestGeneration.current === requestGeneration) {
        profileArtworkRequestGeneration.current += 1
      }
    }
  }, [catalogView, resolvedChannelKey, resolveProfileArtwork, rpc])

  const isOwner = useMemo(() => {
    return Boolean(identity?.driveKey && resolvedChannelKey && identity.driveKey === resolvedChannelKey)
  }, [identity?.driveKey, resolvedChannelKey])

  const selectGroup = useCallback((groupId: string) => {
    thumbnailRequestGeneration.current += 1
    void catalogController.selectGroup(groupId)
  }, [catalogController])

  const retrySelectedGroup = useCallback(() => {
    void catalogController.retrySelectedGroup()
  }, [catalogController])

  const loadMore = useCallback(() => {
    void catalogController.loadMore()
  }, [catalogController])

  const openEditModal = useCallback(() => {
    setEditName(channelProfile?.name || '')
    setEditDescription(channelProfile?.description || '')
    setPickedAvatar(null)
    setEditOpen(true)
  }, [channelProfile?.description, channelProfile?.name])

  const closeEditModal = useCallback(() => {
    if (saving) return
    setEditOpen(false)
    setPickedAvatar(null)
  }, [saving])

  const handlePickAvatar = useCallback(async () => {
    if (!rpc || pickAvatarLoading) return
    setPickAvatarLoading(true)
    try {
      const result = await rpc.pickImageFile()
      if (!result || result.cancelled || !result.filePath) return
      setPickedAvatar({
        filePath: result.filePath,
        dataUrl: result.dataUrl,
        mimeType: result.mimeType,
      })
    } catch (pickError: any) {
      setError(pickError?.message || 'Failed to open image picker')
    } finally {
      setPickAvatarLoading(false)
    }
  }, [rpc, pickAvatarLoading])

  const handleSave = useCallback(async () => {
    if (!rpc || saving) return
    setSaving(true)
    setError(null)
    try {
      await rpc.updateChannel({
        name: editName.trim(),
        description: editDescription.trim(),
      })
      if (pickedAvatar?.filePath) {
        await rpc.updateChannelAvatar({
          filePath: pickedAvatar.filePath,
          mimeType: pickedAvatar.mimeType,
        })
      }
      setEditOpen(false)
      setPickedAvatar(null)
      await loadChannelData()
    } catch (saveError: any) {
      setError(saveError?.message || 'Failed to save channel updates')
    } finally {
      setSaving(false)
    }
  }, [rpc, saving, editName, editDescription, pickedAvatar, loadChannelData])

  if (!resolvedChannelKey) {
    return (
      <div style={styles.page}>
        <style>{pageCss}</style>
        <div style={styles.stateBox}>
          <p style={styles.stateTitle}>No channel key provided</p>
          <p style={styles.stateText}>Open this page with a hash like `#/channel/&lt;channelKey&gt;`.</p>
        </div>
      </div>
    )
  }

  if (catalogState.catalogLoading) {
    return (
      <div style={styles.page}>
        <style>{pageCss}</style>
        <div style={styles.stateBox}>
          <ActivityIndicator size="large" color={colors.primary} />
          <p style={styles.stateText}>Loading channel...</p>
        </div>
      </div>
    )
  }

  if (catalogState.catalogError && !catalogView) {
    return (
      <div style={styles.page}>
        <style>{pageCss}</style>
        <div style={styles.stateBox}>
          <p style={{ ...styles.stateTitle, color: '#eb0400' }}>{catalogState.catalogError}</p>
          <button className="ptButton" type="button" onClick={loadChannelData}>Retry</button>
      </div>
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <style>{pageCss}</style>
      <div style={styles.container}>
        {bannerSrc ? (
          <img
            src={bannerSrc}
            alt=""
            style={styles.bannerImage}
            onError={() => {
              const artwork = profileArtworkCache.banner
              if (!artwork?.url) return
              void resolveProfileArtwork(
                'banner',
                artwork.nextIndex,
                artwork.provisional,
                [...artwork.failedUrls, artwork.url],
              )
            }}
          />
        ) : null}
        <header style={styles.header}>
          <div style={styles.profileRow}>
            {avatarSrc ? (
              <img
                src={avatarSrc}
                alt={channelName}
                style={styles.avatarImage}
                onError={pickedAvatar?.dataUrl ? undefined : () => {
                  const artwork = profileArtworkCache.avatar
                  if (!artwork?.url) return
                  void resolveProfileArtwork(
                    'avatar',
                    artwork.nextIndex,
                    artwork.provisional,
                    [...artwork.failedUrls, artwork.url],
                  )
                }}
              />
            ) : (
              <div style={styles.avatarFallback}>{channelName.charAt(0).toUpperCase()}</div>
            )}
            <div style={styles.profileText}>
              <div style={styles.profileTitleRow}>
                <h1 style={styles.channelName}>{channelName}</h1>
                {catalogView?.badge ? <span style={styles.profileBadge}>{catalogView.badge}</span> : null}
              </div>
              <p style={styles.channelDescription}>{channelDescription}</p>
              <p style={styles.channelKey}>{resolvedChannelKey}</p>
            </div>
          </div>
          {isOwner ? (
            <button className="ptButton" type="button" onClick={openEditModal}>Edit Channel</button>
          ) : null}
        </header>

        {error ? (
          <div style={styles.inlineError}>
            <span>{error}</span>
            <button className="ptLinkButton" type="button" onClick={loadChannelData}>Retry</button>
          </div>
        ) : null}

        {catalogView?.tabs.length ? (
          <div style={styles.tabRow} role="tablist" aria-label="Channel sections">
            {catalogView.tabs.map((tab) => {
              const active = tab.id === selectedGroupId
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => selectGroup(tab.id)}
                  style={{ ...styles.tabButton, ...(active ? styles.tabButtonActive : {}) }}
                >
                  <span>{tab.label}</span>
                  <span style={styles.tabCount}>{tab.itemCount}</span>
                </button>
              )
            })}
          </div>
        ) : null}

        <section>
          <h2 style={styles.sectionTitle}>{selectedTab?.sectionLabel || 'Latest'}</h2>
          {selectedPage.error ? (
            <div style={styles.inlineError}>
              <span>{selectedPage.error}</span>
              <button className="ptLinkButton" type="button" onClick={retrySelectedGroup}>Retry</button>
            </div>
          ) : null}

          {selectedPage.loading ? (
            <div style={styles.stateBox}>
              <ActivityIndicator color={colors.primary} />
              <p style={styles.stateText}>Loading {selectedTab?.label || 'videos'}...</p>
            </div>
          ) : selectedPage.cards.length === 0 && !selectedPage.error ? (
            <div style={styles.stateBox}>
              <p style={styles.stateTitle}>No videos yet</p>
              <p style={styles.stateText}>This section has no published videos.</p>
            </div>
          ) : (
            groupCardsIntoSections(selectedPage.cards).map((cardSection, cardSectionIndex) => (
              <div key={cardSection.label || `videos-${cardSectionIndex}`}>
                {cardSection.label ? <h3 style={styles.seasonHeader}>{cardSection.label}</h3> : null}
                <div style={styles.grid}>
                  {cardSection.cards.map((card) => {
                    const video = card.item
                    const title = video.title || 'Untitled video'
                    const contentBadge = formatContentBadge(video)
                    const resolution = thumbnailCache[`${resolvedChannelKey}:${card.id}`]
                    const thumbnail = resolution?.url || ''
                    let handleThumbnailError: (() => void) | undefined
                    if (resolution?.url) {
                      const failedUrl = resolution.url
                      handleThumbnailError = () => {
                        void resolveCardArtwork(
                          card,
                          resolution.nextIndex,
                          resolution.provisional,
                          [...resolution.failedUrls, failedUrl],
                        )
                      }
                    }
                    return (
                      <button
                        key={card.id}
                        className="ptVideoCard"
                        onClick={() => {
                          if (typeof window === 'undefined') return
                          const playbackPayload = createChannelPlaybackPayload({
                            item: video,
                            channelKey: resolvedChannelKey,
                            publicBeeKey: resolvedPublicBeeKey,
                            thumbnailUrl: thumbnail || null,
                            channelName,
                          })
                          stageWebChannelPlayback(window, playbackPayload)
                          window.location.hash = `/watch/${encodeURIComponent(resolvedChannelKey)}/${encodeURIComponent(card.item.id)}`
                        }}
                      >
                        <div style={styles.thumbWrap}>
                          {thumbnail ? (
                            <img
                              src={thumbnail}
                              alt={title}
                              style={styles.thumbnail}
                              loading="lazy"
                              onError={handleThumbnailError}
                            />
                          ) : (
                            <div style={styles.thumbnailFallback}>No thumbnail</div>
                          )}
                        </div>
                        <div style={styles.videoMeta}>
                          <h3 style={styles.videoTitle}>{title}</h3>
                          <p style={styles.videoTime}>
                            {contentBadge ? `${contentBadge} · ` : ''}{formatTimeAgo(video.sourcePublishedAt || video.originalAirDate)}
                          </p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </section>

        {selectedPage.nextCursor ? (
          <button className="ptButton" type="button" onClick={loadMore} disabled={selectedPage.loadingMore} style={styles.loadMoreButton}>
            {selectedPage.loadingMore ? 'Loading...' : 'Load more'}
          </button>
        ) : null}
      </div>

      {editOpen ? (
        <div style={styles.modalOverlay}>
          <div style={styles.modal}>
            <h2 style={styles.modalTitle}>Edit Channel</h2>
            <label style={styles.fieldLabel}>
              Name
              <input
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                style={styles.input}
                placeholder="Channel name"
                maxLength={80}
              />
            </label>
            <label style={styles.fieldLabel}>
              Description
              <textarea
                value={editDescription}
                onChange={(event) => setEditDescription(event.target.value)}
                style={styles.textarea}
                placeholder="Describe your channel"
                rows={4}
                maxLength={500}
              />
            </label>

            <div style={styles.avatarPickerRow}>
              <button className="ptButton ptButtonSecondary" type="button" onClick={handlePickAvatar} disabled={pickAvatarLoading}>
                {pickAvatarLoading ? 'Opening picker...' : 'Pick Avatar'}
              </button>
              {pickedAvatar?.dataUrl ? (
                <img src={pickedAvatar.dataUrl} alt="Selected avatar" style={styles.modalAvatarPreview} />
              ) : null}
            </div>

            <div style={styles.modalActions}>
              <button className="ptButton ptButtonSecondary" type="button" onClick={closeEditModal} disabled={saving}>Cancel</button>
              <button className="ptButton" type="button" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    backgroundColor: '#0e0e10',
    color: '#efeff1',
    padding: '24px',
  },
  container: {
    maxWidth: 1100,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 16,
    backgroundColor: '#1f1f23',
    border: '1px solid #2f2f35',
    borderRadius: 14,
    padding: 18,
  },
  profileRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 14,
  },
  profileText: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  avatarImage: {
    width: 64,
    height: 64,
    borderRadius: 32,
    objectFit: 'cover',
    backgroundColor: '#0e0e10',
  },
  avatarFallback: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#9147ff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: 24,
    color: '#fff',
  },
  channelName: {
    margin: 0,
    fontSize: 28,
    lineHeight: 1.2,
    color: '#efeff1',
  },
  channelDescription: {
    margin: 0,
    color: '#adadb8',
    fontSize: 14,
  },
  channelKey: {
    margin: 0,
    color: '#53535f',
    fontSize: 12,
    wordBreak: 'break-all',
  },
  seasonHeader: {
    margin: '18px 0 10px',
    fontSize: 17,
    fontWeight: 700,
    color: colors.text,
  },
  grid: {
    display: 'grid',
    gap: 16,
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  },
  thumbWrap: {
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#0e0e10',
  },
  thumbnail: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  thumbnailFallback: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#53535f',
    fontSize: 13,
  },
  videoMeta: {
    padding: '10px 2px 0',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  videoTitle: {
    margin: 0,
    color: '#efeff1',
    fontSize: 14,
    lineHeight: 1.3,
  },
  videoTime: {
    margin: 0,
    color: '#adadb8',
    fontSize: 12,
  },
  stateBox: {
    backgroundColor: '#1f1f23',
    border: '1px solid #2f2f35',
    borderRadius: 14,
    padding: 24,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
  },
  stateTitle: {
    margin: 0,
    color: '#efeff1',
    fontSize: 16,
    fontWeight: 600,
  },
  stateText: {
    margin: 0,
    color: '#adadb8',
    fontSize: 14,
  },
  inlineError: {
    backgroundColor: 'rgba(235, 4, 0, 0.12)',
    border: '1px solid rgba(235, 4, 0, 0.35)',
    color: '#efeff1',
    borderRadius: 10,
    padding: '10px 12px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    zIndex: 40,
  },
  modal: {
    width: '100%',
    maxWidth: 520,
    borderRadius: 14,
    backgroundColor: '#1f1f23',
    border: '1px solid #2f2f35',
    padding: 18,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  modalTitle: {
    margin: 0,
    color: '#efeff1',
    fontSize: 20,
  },
  fieldLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    color: '#adadb8',
    fontSize: 13,
  },
  input: {
    borderRadius: 10,
    border: '1px solid #2f2f35',
    backgroundColor: '#0e0e10',
    color: '#efeff1',
    padding: '10px 12px',
    fontSize: 14,
    outline: 'none',
  },
  textarea: {
    borderRadius: 10,
    border: '1px solid #2f2f35',
    backgroundColor: '#0e0e10',
    color: '#efeff1',
    padding: '10px 12px',
    fontSize: 14,
    outline: 'none',
    resize: 'vertical',
    minHeight: 96,
    fontFamily: 'inherit',
  },
  avatarPickerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  modalAvatarPreview: {
    width: 42,
    height: 42,
    borderRadius: 21,
    objectFit: 'cover',
    border: '1px solid #2f2f35',
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
  },
  bannerImage: {
    width: '100%',
    maxHeight: 260,
    aspectRatio: '16 / 5',
    objectFit: 'cover',
    borderRadius: 14,
    border: '1px solid #2f2f35',
    backgroundColor: '#1f1f23',
  },
  profileTitleRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
  },
  profileBadge: {
    borderRadius: 999,
    padding: '4px 9px',
    backgroundColor: '#9147ff',
    color: '#fff',
    fontSize: 11,
    fontWeight: 700,
  },
  tabRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
  },
  tabButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    borderRadius: 999,
    border: '1px solid #2f2f35',
    backgroundColor: '#1f1f23',
    color: '#adadb8',
    padding: '8px 12px',
    cursor: 'pointer',
  },
  tabButtonActive: {
    borderColor: '#9147ff',
    backgroundColor: '#9147ff',
    color: '#fff',
  },
  tabCount: {
    fontSize: 11,
    opacity: 0.75,
  },
  sectionTitle: {
    margin: '0 0 14px',
    color: '#efeff1',
    fontSize: 20,
  },
  loadMoreButton: {
    alignSelf: 'center',
    minWidth: 140,
  },
}

const pageCss = `
  .ptButton {
    border: none;
    border-radius: 10px;
    background: #9147ff;
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    padding: 9px 14px;
    cursor: pointer;
    transition: background-color 0.16s ease, transform 0.16s ease;
  }

  .ptButton:hover {
    background: #7f37e8;
    transform: translateY(-1px);
  }

  .ptButton:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    transform: none;
  }

  .ptButtonSecondary {
    background: #2a2a31;
    color: #efeff1;
    border: 1px solid #3b3b43;
  }

  .ptButtonSecondary:hover {
    background: #35353d;
  }

  .ptLinkButton {
    background: transparent;
    border: none;
    color: #9147ff;
    cursor: pointer;
    padding: 0;
    font-size: 13px;
  }

  .ptLinkButton:hover {
    color: #aa77ff;
  }

  .ptVideoCard {
    background: #1f1f23;
    border: 1px solid #2f2f35;
    border-radius: 12px;
    padding: 10px;
    cursor: pointer;
    transition: transform 0.16s ease, border-color 0.16s ease, background-color 0.16s ease;
    outline: none;
    width: 100%;
    text-align: left;
  }

  .ptVideoCard:hover {
    transform: translateY(-2px);
    border-color: #45454f;
    background: #25252c;
  }

  .ptVideoCard:focus-visible {
    box-shadow: 0 0 0 2px #9147ff;
  }
`
