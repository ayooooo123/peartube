const PROFILE_KINDS = new Set(['tvShow', 'movie', 'creator', 'standard'])

const GROUP_LABELS = {
  latest: 'Latest',
  videos: 'Videos',
  streams: 'Streams',
  movie: 'Movie',
  trailers: 'Trailers',
  extras: 'Extras',
}

function asArray(value) {
  return Array.isArray(value) ? value.slice() : []
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function normalizedProfileKind(profile) {
  const kind = profile?.profileKind
  return PROFILE_KINDS.has(kind) ? kind : 'standard'
}

function profileBadge(kind) {
  if (kind === 'tvShow') return 'TV'
  if (kind === 'movie') return 'Movie'
  if (kind === 'creator') return 'Creator'
  return null
}

function groupLabel(group) {
  if (group?.kind === 'season' && Number.isSafeInteger(group.seasonNumber)) {
    return `Season ${group.seasonNumber}`
  }
  return GROUP_LABELS[group?.id] ?? GROUP_LABELS[group?.kind] ?? group?.title ?? ''
}

function sectionLabel(group) {
  return group?.kind === 'season' ? 'Episodes' : groupLabel(group)
}

function roleOrder(profile, placement) {
  const kind = normalizedProfileKind(profile)
  const mediaProfile = kind === 'tvShow' || kind === 'movie'
  if (placement === 'banner') {
    return mediaProfile ? ['backdrop', 'banner'] : ['banner', 'backdrop']
  }
  return mediaProfile ? ['poster', 'avatar'] : ['avatar', 'poster']
}

function artworkCandidates(artwork, roles) {
  const candidates = []
  for (const role of roles) {
    for (const entry of artwork) {
      if (entry?.role !== role) continue
      if (nonEmptyString(entry.blobId) && nonEmptyString(entry.blobsCoreKey)) {
        candidates.push({
          kind: 'blob',
          role,
          blobId: entry.blobId,
          blobsCoreKey: entry.blobsCoreKey,
          mimeType: nonEmptyString(entry.mimeType) ? entry.mimeType : null,
        })
      }
      if (nonEmptyString(entry.remoteUrl)) {
        candidates.push({ kind: 'remote', role, url: entry.remoteUrl })
      }
    }
  }
  return candidates
}

export function profileArtworkCandidates(profile, placement = 'card') {
  return artworkCandidates(asArray(profile?.artwork), roleOrder(profile, placement))
}

export function cardArtworkCandidates(item, profile) {
  const candidates = []
  if (nonEmptyString(item?.thumbnailBlobId) && nonEmptyString(item?.thumbnailBlobsCoreKey)) {
    candidates.push({
      kind: 'blob',
      role: 'thumbnail',
      blobId: item.thumbnailBlobId,
      blobsCoreKey: item.thumbnailBlobsCoreKey,
      mimeType: nonEmptyString(item.thumbnailMimeType) ? item.thumbnailMimeType : null,
    })
  }
  if (nonEmptyString(item?.thumbnailUrl)) {
    candidates.push({ kind: 'remote', role: 'thumbnail', url: item.thumbnailUrl })
  }
  candidates.push(...profileArtworkCandidates(profile, 'card'))
  return candidates
}

export function mapContentCatalog(response = {}) {
  const profile = response?.profile ?? null
  const profileKind = normalizedProfileKind(profile)
  const sources = asArray(profile?.sources)
  const artwork = asArray(profile?.artwork)
  const groups = asArray(response?.groups).filter((group) => (
    group !== null && typeof group === 'object' && Number.isSafeInteger(group.itemCount) && group.itemCount > 0
  ))
  const tabs = groups.map((group) => ({
    id: group.id,
    label: groupLabel(group),
    sectionLabel: sectionLabel(group),
    itemCount: group.itemCount,
    group,
  }))

  return {
    profile,
    profileKind,
    badge: profileBadge(profileKind),
    sources,
    artwork,
    profileArtwork: {
      avatar: profileArtworkCandidates(profile, 'card'),
      banner: profileArtworkCandidates(profile, 'banner'),
      card: profileArtworkCandidates(profile, 'card'),
    },
    groups,
    tabs,
  }
}

export function mapContentItems(response = {}, profile = null) {
  const group = response?.group ?? null
  const items = asArray(response?.items)
  const cards = items.map((item) => ({
    id: item?.id,
    item,
    artworkCandidates: cardArtworkCandidates(item, profile),
  }))
  const section = group && items.length > 0
    ? {
        id: group.id,
        label: sectionLabel(group),
        tabLabel: groupLabel(group),
        group,
        items,
        cards,
      }
    : null

  return {
    group,
    items,
    cards,
    section,
    nextCursor: response?.nextCursor ?? null,
  }
}
