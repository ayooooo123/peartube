// Movies/Shows are content-type filters (from TMDB-classified imports), not
// uploader-chosen categories; everything else matches video.category exactly.
export function matchesHomeFeedCategory(video, activeCategory) {
  if (activeCategory === 'All') return true
  if (activeCategory === 'Movies') return video?.contentKind === 'movie' || video?.classification?.type === 'movie'
  if (activeCategory === 'Shows') return video?.contentKind === 'episode' || video?.classification?.type === 'tv'
  return video?.category === activeCategory
}

export function getHomeFeedVideosForCategory(videos, activeCategory) {
  if (activeCategory === 'All') return videos
  return videos.filter((video) => matchesHomeFeedCategory(video, activeCategory))
}

export function chunkHomeFeedRows(videos, columns) {
  const safeColumns = Math.max(1, Math.floor(Number(columns) || 1))
  const rows = []
  for (let index = 0; index < videos.length; index += safeColumns) {
    rows.push(videos.slice(index, index + safeColumns))
  }
  return rows
}

export function getVirtualizedHomeFeedRows({ videos, activeCategory = 'All', columns = 1 }) {
  return chunkHomeFeedRows(getHomeFeedVideosForCategory(videos, activeCategory), columns)
}
