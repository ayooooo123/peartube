export function createLocalMediaIndex(options = {}) {
  const maxRecords = Number.isSafeInteger(options.maxRecords) ? options.maxRecords : 10000
  const records = []

  function trim() {
    while (records.length > maxRecords) records.shift()
  }

  function project(recordGroup) {
    const first = recordGroup[0]
    const publications = []
    const provenance = new Set()
    const tags = new Set()
    for (const record of recordGroup) {
      provenance.add(record.sourceId)
      for (const tag of record.tags || []) tags.add(tag)
      publications.push({ publicationId: record.publicationId, publisherId: record.publisherId, title: record.title || null, playable: record.playable === true })
    }
    return {
      entityRef: first.entityRef,
      title: first.title || publications.find(p => p.title)?.title || null,
      creator: first.creator || null,
      collectionId: first.collectionId || null,
      tags: Array.from(tags).sort(),
      publications,
      provenance: Array.from(provenance).filter(Boolean).sort(),
      playable: publications.some(publication => publication.playable),
    }
  }

  return {
    ingestRecords(nextRecords = []) {
      for (const record of nextRecords || []) {
        if (!record?.entityRef || !record?.publicationId) continue
        records.push({ ...record, playable: record.playable === true })
      }
      trim()
    },
    search(query = '') {
      const q = String(query).toLowerCase()
      const byEntity = new Map()
      for (const record of records) {
        const haystack = `${record.entityRef} ${record.title || ''} ${record.creator || ''} ${(record.tags || []).join(' ')}`.toLowerCase()
        if (q && !haystack.includes(q)) continue
        const list = byEntity.get(record.entityRef) || []
        list.push(record)
        byEntity.set(record.entityRef, list)
      }
      return Array.from(byEntity.values()).map(project)
    },
    records() { return records.slice() },
  }
}
