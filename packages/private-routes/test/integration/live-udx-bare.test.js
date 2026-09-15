import { createRequire } from 'node:module'

import { registerLiveUdxProcessSuite } from './live-udx-process-suite.js'

const require = createRequire(import.meta.url)

registerLiveUdxProcessSuite({
  label: 'Bare',
  runtime: 'bare',
  runtimeVersion: 'v1.30.3',
  adapter: 'bare-process',
  command: require('bare-runtime')('bare')
})
