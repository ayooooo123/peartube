import { HybridObject } from 'react-native-nitro-modules'

export interface NitroVLCPOC extends HybridObject<{ ios: 'swift' }> {
  getVLCVersion(): string
}
