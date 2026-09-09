import test from 'brittle'

import { createProcessCodecVectors } from './process/codec-vectors.js'

test('process bootstrap and control vectors round-trip to stable fingerprints', (t) => {
  const vectors = createProcessCodecVectors()
  t.alike(vectors, {
    bootstrap: 'f754d5f8cacb42f68883c575535fe6505a3a6b014150173a0fedfdbbf7bfb73c',
    control: '4e501e51596b27944f5ba26f91f1d5045f5d06018372ee39c97cecd3e4ad94e4'
  })
})
