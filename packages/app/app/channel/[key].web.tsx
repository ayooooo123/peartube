import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator } from 'react-native'
import { useApp, colors } from '../_layout'
import { formatTimeAgo } from '@/lib/formatters'
import { withChannelPageTimeout, isTimedOutResult } from '@/lib/channel-page'

type ChannelMeta = {
  name?: string
  description?: string
  avatar?: string | null
  avatarUrl?: string | null
}

type VideoItem = {
  id: string
  title?: string
  uploadedAt?: number
  thumbnail?: string | null
  thumbnailUrl?: string | null
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

export default function ChannelPageWeb(props: ChannelPageProps) {
  const { rpc, identity } = useApp()
  const propChannelKey = props.channelKey || props.params?.key || ''
  const propPublicBeeKey = props.publicBeeKey || props.params?.publicBeeKey || ''

  const initialRouteParams = useMemo(() => {
    if (propChannelKey) return { channelKey: propChannelKey, publicBeeKey: propPublicBeeKey }
    if (typeof window === 'undefined') return { channelKey: '', publicBeeKey: '' }
    return parseChannelKeyFromHash(window.location.hash)
  }, [propChannelKey, propPublicBeeKey])

  const [resolvedChannelKey, setResolvedChannelKey] = useState<string>(initialRouteParams.channelKey)
  const [resolvedPublicBeeKey, setResolvedPublicBeeKey] = useState<string>(initialRouteParams.publicBeeKey)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [channelMeta, setChannelMeta] = useState<ChannelMeta | null>(null)
  const [videos, setVideos] = useState<VideoItem[]>([])

  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [pickedAvatar, setPickedAvatar] = useState<PickedAvatar | null>(null)
  const [pickAvatarLoading, setPickAvatarLoading] = useState(false)
  const [saving, setSaving] = useState(false)

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

  const loadChannelData = useCallback(async () => {
    if (!rpc || !resolvedChannelKey) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const [metaSettled, videosSettled] = await Promise.allSettled([
        withChannelPageTimeout(rpc.getChannelMeta({ channelKey: resolvedChannelKey, publicBeeKey: resolvedPublicBeeKey || undefined })),
        withChannelPageTimeout(rpc.listVideos({ channelKey: resolvedChannelKey, publicBeeKey: resolvedPublicBeeKey || undefined })),
      ])

      const metaResult = metaSettled.status === 'fulfilled' ? metaSettled.value : null
      if (!isTimedOutResult(metaResult) && metaResult) {
        setChannelMeta(metaResult || null)
      }

      const videosResult = videosSettled.status === 'fulfilled' ? videosSettled.value : null
      if (isTimedOutResult(videosResult)) {
        setError('Video list is taking longer than expected. Showing cached channel details; retry to refresh videos.')
      } else if (videosSettled.status === 'rejected') {
        setError(videosSettled.reason?.message || 'Failed to load videos')
      } else if ((videosResult as any)?.success === false) {
        setError((videosResult as any)?.error || 'Failed to load videos')
      } else {
        setVideos(Array.isArray((videosResult as any)?.videos) ? (videosResult as any).videos : [])
      }

      if (metaSettled.status === 'rejected' && videosSettled.status === 'rejected') {
        setError(metaSettled.reason?.message || videosSettled.reason?.message || 'Failed to load channel')
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load channel')
    } finally {
      setLoading(false)
    }
  }, [rpc, resolvedChannelKey, resolvedPublicBeeKey])

  useEffect(() => {
    loadChannelData()
  }, [loadChannelData])

  const isOwner = useMemo(() => {
    return Boolean(identity?.driveKey && resolvedChannelKey && identity.driveKey === resolvedChannelKey)
  }, [identity?.driveKey, resolvedChannelKey])

  const channelName = channelMeta?.name?.trim() || `Channel ${resolvedChannelKey.slice(0, 8) || 'Unknown'}`
  const channelDescription = channelMeta?.description?.trim() || 'No description yet.'
  const avatarSrc = pickedAvatar?.dataUrl || channelMeta?.avatar || channelMeta?.avatarUrl || ''

  const openEditModal = useCallback(() => {
    setEditName(channelMeta?.name || '')
    setEditDescription(channelMeta?.description || '')
    setPickedAvatar(null)
    setEditOpen(true)
  }, [channelMeta?.description, channelMeta?.name])

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
    } catch (err: any) {
      setError(err?.message || 'Failed to open image picker')
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
    } catch (err: any) {
      setError(err?.message || 'Failed to save channel updates')
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

  if (loading) {
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

  if (error && !channelMeta) {
    return (
      <div style={styles.page}>
        <style>{pageCss}</style>
        <div style={styles.stateBox}>
          <p style={{ ...styles.stateTitle, color: '#eb0400' }}>{error}</p>
          <button className="ptButton" type="button" onClick={loadChannelData}>Retry</button>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <style>{pageCss}</style>

      <div style={styles.container}>
        <header style={styles.header}>
          <div style={styles.profileRow}>
            {avatarSrc ? (
              <img src={avatarSrc} alt={channelName} style={styles.avatarImage} />
            ) : (
              <div style={styles.avatarFallback}>{channelName.charAt(0).toUpperCase()}</div>
            )}
            <div style={styles.profileText}>
              <h1 style={styles.channelName}>{channelName}</h1>
              <p style={styles.channelDescription}>{channelDescription}</p>
              <p style={styles.channelKey}>{resolvedChannelKey}</p>
            </div>
          </div>
          {isOwner && (
            <button className="ptButton" type="button" onClick={openEditModal}>
              Edit Channel
            </button>
          )}
        </header>

        {error ? (
          <div style={styles.inlineError}>
            <span>{error}</span>
            <button className="ptLinkButton" type="button" onClick={loadChannelData}>Retry</button>
          </div>
        ) : null}

        {videos.length === 0 ? (
          <div style={styles.stateBox}>
            <p style={styles.stateTitle}>No videos yet</p>
            <p style={styles.stateText}>This channel has not uploaded any videos.</p>
          </div>
        ) : (
          <section style={styles.grid}>
            {videos.map((video) => {
              const title = video.title || 'Untitled video'
              const thumbnail = video.thumbnail || video.thumbnailUrl || ''
              return (
                <button
                  key={video.id}
                  type="button"
                  className="ptVideoCard"
                  onClick={() => {
                    if (typeof window !== 'undefined') {
                      window.location.hash = `/watch/${encodeURIComponent(resolvedChannelKey)}/${encodeURIComponent(video.id)}`
                    }
                  }}
                >
                  <div style={styles.thumbWrap}>
                    {thumbnail ? (
                      <img src={thumbnail} alt={title} style={styles.thumbnail} loading="lazy" />
                    ) : (
                      <div style={styles.thumbnailFallback}>No thumbnail</div>
                    )}
                  </div>
                  <div style={styles.videoMeta}>
                    <h3 style={styles.videoTitle}>{title}</h3>
                    <p style={styles.videoTime}>{formatTimeAgo(video.uploadedAt)}</p>
                  </div>
                </button>
              )
            })}
          </section>
        )}
      </div>

      {editOpen && (
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
      )}
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
