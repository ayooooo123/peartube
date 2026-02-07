import { HybridObject } from 'react-native-nitro-modules'
import type { NitroVLCView } from './NitroVLC.nitro'

export interface NitroVLCModule extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  getVLCVersion(): string
  getView(viewId: string): NitroVLCView | undefined
}
