const MAX_AVAILABILITY_RANGES = 128

function normalizeRange(range = {}, coreLength) {
  const start = Number(range.start)
  const end = Number(range.end)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > coreLength) {
    throw new Error('invalid availability range')
  }
  return { start, end }
}

export function createAvailabilitySummary(input = {}) {
  const coreLength = Number(input.coreLength)
  if (!Number.isSafeInteger(coreLength) || coreLength < 0) throw new Error('coreLength must be non-negative integer')
  const ranges = input.ranges || []
  if (!Array.isArray(ranges) || ranges.length > MAX_AVAILABILITY_RANGES) throw new Error('too many availability ranges')
  return {
    renditionId: String(input.renditionId || ''),
    coreLength,
    ranges: ranges.map(range => normalizeRange(range, coreLength)).sort((a, b) => a.start - b.start || a.end - b.end),
  }
}

function covers(delivered = [], target = {}) {
  return delivered.some(range => Number(range.start) <= target.start && Number(range.end) >= target.end)
}

export function verifyAvailabilityDelivery(summary, proof = {}) {
  if (!summary || proof.renditionId !== summary.renditionId) return false
  const delivered = Array.isArray(proof.delivered) ? proof.delivered : []
  return summary.ranges.every(range => covers(delivered, range))
}
