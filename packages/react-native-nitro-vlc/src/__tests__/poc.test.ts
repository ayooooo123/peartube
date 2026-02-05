import { test, expect } from 'bun:test'
import { NitroModules } from 'react-native-nitro-modules'
import type { NitroVLCPOC } from '../NitroVLCPOC.nitro'

test('NitroVLCPOC returns VLC version', () => {
  const module = NitroModules.createHybridObject<NitroVLCPOC>('NitroVLCPOC')
  const version = module.getVLCVersion()

  expect(typeof version).toBe('string')
  expect(version).toMatch(/^\d+\.\d+\.\d+/)
})
