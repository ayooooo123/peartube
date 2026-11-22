// mDNS in memory, for LAN discovery tests. Every browse hears every
// advertisement, at 127.0.0.1, through that side's view(service), which can
// change what it sees. With `goodbyes`, a stopped advertisement goes down on
// every browse, as bonjour-service's goodbye packet does.
export function mdnsBus ({ goodbyes = false } = {}) {
  const records = new Set()
  const browsers = new Set()
  return (view = service => service) => ({
    advertise (record) {
      records.add(record)
      for (const b of browsers) b.hear(record)
      return {
        stop: async () => {
          if (!records.delete(record) || !goodbyes) return
          for (const b of browsers) b.bye(record)
        }
      }
    },
    browse (query, handlers) {
      const seen = record => view({ ...record, addresses: ['127.0.0.1'] })
      const b = { hear: record => handlers.onService(seen(record)), bye: record => handlers.onServiceDown?.(seen(record)) }
      browsers.add(b)
      for (const record of records) b.hear(record)
      return { stop: async () => browsers.delete(b) }
    }
  })
}
