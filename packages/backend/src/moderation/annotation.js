export function createAiAnnotation(input = {}) {
  const ranges = input.analyzedRanges || []
  if (!Array.isArray(ranges) || ranges.length > 128) throw new Error('too many analyzed ranges')
  return {
    kind: 'ai-annotation',
    issuer: String(input.issuer || ''),
    model: { id: String(input.modelId || ''), version: String(input.modelVersion || '') },
    analyzedRanges: ranges.map(range => ({ start: Number(range.start), end: Number(range.end) })),
    labels: (input.labels || []).map(label => ({ label: String(label.label || ''), confidence: Number(label.confidence || 0) })),
    createdAt: Number(input.createdAt || 0),
    mutatesCanonicalData: false,
  }
}
