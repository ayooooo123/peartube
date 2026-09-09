import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator } from 'react-native'
import { useApp } from '../_layout'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
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
          <p style={{ ...styles.stateTitle, color: colors.error }}>{catalogState.catalogError}</p>
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
              <p style={styles.channelEyebrow}>CHANNEL · {(resolvedChannelKey || '').slice(0, 12) || 'UNKNOWN'}</p>
              <div style={styles.profileTitleRow}>
                <h1 style={styles.channelName}>{channelName}</h1>
                {catalogView?.badge ? <span style={styles.profileBadge}>{catalogView.badge}</span> : null}
              </div>
              <p style={styles.channelDescription}>{channelDescription}</p>
              <p style={styles.metaLine}>{(selectedTab?.itemCount ?? selectedPage.cards.length)} VIDEOS{catalogView?.badge ? ` · ${String(catalogView.badge).toUpperCase()}` : ''}</p>
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
    backgroundColor: colors.bg,
    color: colors.text,
    padding: spacing.xl,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  container: {
    maxWidth: 1100,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.xl,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.lg,
    backgroundColor: colors.bg,
    borderBottom: `${borderWidth.rule}px solid ${colors.primary}`,
    paddingBottom: spacing.lg,
  },
  profileRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  profileText: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.sm,
  },
  avatarImage: {
    width: 72,
    height: 72,
    borderRadius: radius.card,
    objectFit: 'cover',
    backgroundColor: colors.surface,
    border: `${borderWidth.rule}px solid ${colors.border}`,
  },
  avatarFallback: {
    width: 72,
    height: 72,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    border: `${borderWidth.rule}px solid ${colors.border}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: fonts.display,
    fontSize: 24,
    color: colors.primary,
  },
  channelEyebrow: {
    margin: 0,
    ...fonts.caption.sm,
    color: colors.textMuted,
  },
  channelName: {
    margin: 0,
    ...fonts.title.xl,
    color: colors.text,
  },
  channelDescription: {
    margin: 0,
    ...fonts.body.sm,
    color: colors.textSecondary,
  },
  channelKey: {
    margin: 0,
    ...fonts.meta.sm,
    color: colors.textMuted,
    wordBreak: 'break-all',
  },
  seasonHeader: {
    margin: `${spacing.lg}px 0 ${spacing.md}px`,
    ...fonts.title.md,
    textTransform: 'uppercase',
    color: colors.text,
  },
  grid: {
    display: 'grid',
    gap: spacing.lg,
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  },
  thumbWrap: {
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: radius.card,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    border: `${borderWidth.hairline}px solid ${colors.borderSubtle}`,
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
    color: colors.textMuted,
    ...fonts.meta.sm,
  },
  videoMeta: {
    padding: `${spacing.md}px 2px 0`,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.xs,
  },
  videoTitle: {
    margin: 0,
    ...fonts.title.md,
    fontSize: 15,
    lineHeight: '20px',
    color: colors.text,
  },
  videoTime: {
    margin: 0,
    ...fonts.meta.sm,
    color: colors.textMuted,
  },
  stateBox: {
    backgroundColor: colors.surface,
    border: `${borderWidth.rule}px solid ${colors.border}`,
    borderRadius: radius.card,
    padding: spacing.xl,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacing.md,
  },
  stateTitle: {
    margin: 0,
    ...fonts.title.md,
    color: colors.text,
    textTransform: 'uppercase',
  },
  stateText: {
    margin: 0,
    ...fonts.body.sm,
    color: colors.textSecondary,
  },
  inlineError: {
    backgroundColor: colors.errorLight,
    border: `${borderWidth.rule}px solid ${colors.error}`,
    color: colors.text,
    borderRadius: radius.card,
    padding: `${spacing.sm}px ${spacing.md}px`,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
  },
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: colors.scrim,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    zIndex: 40,
  },
  modal: {
    width: '100%',
    maxWidth: 520,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    border: `${borderWidth.rule}px solid ${colors.border}`,
    padding: spacing.lg,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.md,
  },
  modalTitle: {
    margin: 0,
    ...fonts.title.md,
    color: colors.text,
    textTransform: 'uppercase',
  },
  fieldLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.sm,
    ...fonts.caption.sm,
    color: colors.textMuted,
  },
  input: {
    borderRadius: radius.card,
    border: `${borderWidth.rule}px solid ${colors.border}`,
    backgroundColor: colors.surfaceHover,
    color: colors.text,
    padding: `${spacing.sm}px ${spacing.md}px`,
    fontSize: 14,
    outline: 'none',
    fontFamily: 'inherit',
  },
  textarea: {
    borderRadius: radius.card,
    border: `${borderWidth.rule}px solid ${colors.border}`,
    backgroundColor: colors.surfaceHover,
    color: colors.text,
    padding: `${spacing.sm}px ${spacing.md}px`,
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
    gap: spacing.md,
  },
  modalAvatarPreview: {
    width: 42,
    height: 42,
    borderRadius: radius.card,
    objectFit: 'cover',
    border: `${borderWidth.hairline}px solid ${colors.border}`,
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  bannerImage: {
    width: '100%',
    maxHeight: 260,
    aspectRatio: '16 / 5',
    objectFit: 'cover',
    borderRadius: radius.card,
    border: `${borderWidth.hairline}px solid ${colors.borderSubtle}`,
    backgroundColor: colors.surface,
  },
  profileTitleRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  profileBadge: {
    borderRadius: radius.md,
    padding: '4px 9px',
    backgroundColor: colors.primary,
    color: colors.onPrimary,
    ...fonts.caption.sm,
    fontSize: 10,
  },
  tabRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: spacing.md,
    borderBottom: `${borderWidth.rule}px solid ${colors.border}`,
  },
  tabButton: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: 0,
    border: 'none',
    borderBottom: `${borderWidth.rule}px solid transparent`,
    marginBottom: -borderWidth.rule,
    backgroundColor: 'transparent',
    color: colors.textMuted,
    padding: `${spacing.md}px ${spacing.xs}px`,
    cursor: 'pointer',
    ...fonts.caption.sm,
  },
  tabButtonActive: {
    borderBottomColor: colors.primary,
    color: colors.primary,
    backgroundColor: 'transparent',
  },
  tabCount: {
    ...fonts.meta.xs,
    opacity: 0.85,
  },
  sectionTitle: {
    margin: `0 0 ${spacing.md}px`,
    ...fonts.title.md,
    color: colors.text,
    textTransform: 'uppercase',
    borderLeft: `${borderWidth.rule}px solid ${colors.primary}`,
    paddingLeft: spacing.md,
  },
  loadMoreButton: {
    alignSelf: 'center',
    minWidth: 140,
  },
  metaLine: {
    margin: 0,
    ...fonts.meta.sm,
    color: colors.textMuted,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
}

const pageCss = `
  .ptButton {
    border: ${borderWidth.rule}px solid ${colors.primary};
    border-radius: ${radius.card}px;
    background: ${colors.primary};
    color: ${colors.onPrimary};
    font-family: ${fonts.heading};
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    padding: 10px 14px;
    cursor: pointer;
  }

  .ptButton:hover {
    background: ${colors.primaryHover};
    border-color: ${colors.primaryHover};
  }

  .ptButton:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .ptButtonSecondary {
    background: ${colors.bg};
    border: ${borderWidth.rule}px solid ${colors.border};
    color: ${colors.text};
  }

  .ptButtonSecondary:hover {
    background: ${colors.surfaceHover};
    border-color: ${colors.borderLight};
  }

  .ptLinkButton {
    background: transparent;
    border: none;
    color: ${colors.primary};
    cursor: pointer;
    padding: 0;
    font-family: ${fonts.monoMedium};
    font-size: 12px;
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  .ptLinkButton:hover {
    color: ${colors.primaryHover};
  }

  .ptVideoCard {
    background: ${colors.bg};
    border: none;
    border-radius: 0;
    padding: 0;
    cursor: pointer;
    outline: none;
    width: 100%;
    text-align: left;
  }

  .ptVideoCard:hover .ptThumbFrame {
    border-color: ${colors.borderLight};
  }

  .ptVideoCard:focus-visible {
    outline: ${borderWidth.rule}px solid ${colors.borderFocus};
    outline-offset: 2px;
  }
`
