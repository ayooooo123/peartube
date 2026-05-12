export function getHomeFeedVideosForCategory(videos, activeCategory) {
  if (activeCategory === 'All') return videos
  return videos.filter((video) => video?.category === activeCategory)
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
