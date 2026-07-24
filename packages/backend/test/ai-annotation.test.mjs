import test from 'brittle'

import { createAiAnnotation } from '../src/moderation/annotation.js'

test('AI annotation is derived metadata with model provenance and bounded analyzed ranges', (t) => {
  const annotation = createAiAnnotation({ issuer: 'local-model', modelId: 'classifier', modelVersion: '1', analyzedRanges: [{ start: 0, end: 10 }], labels: [{ label: 'violence', confidence: 0.7 }], createdAt: 10 })
  t.is(annotation.kind, 'ai-annotation')
  t.is(annotation.model.id, 'classifier')
  t.is(annotation.mutatesCanonicalData, false)
  t.exception(() => createAiAnnotation({ issuer: 'x', modelId: 'm', modelVersion: '1', analyzedRanges: Array.from({ length: 129 }, () => ({ start: 0, end: 1 })) }), /too many/)
})
