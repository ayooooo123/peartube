import { registerLiveUdxProcessSuite } from './live-udx-process-suite.js'

registerLiveUdxProcessSuite({
  label: 'Node',
  runtime: 'node',
  runtimeVersion: process.version,
  adapter: 'node-process',
  command: process.execPath
})
