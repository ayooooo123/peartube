import { getHostComponent, NitroModules } from 'react-native-nitro-modules'
import type { NitroVLCModule as NitroVLCModuleType } from './NitroVLCModule.nitro'

export const name = 'NitroVLC'

/**
 * Plain React Native native component backed by SimpleViewManager/RCTViewManager.
 * Only accepts `viewId` (and `style`) as props — all other configuration is done
 * imperatively via NitroVLCModule.getView(viewId) to avoid Fabric CachedProp crashes.
 *
 * Uses getHostComponent (which calls NativeComponentRegistry.get internally) to
 * register the view config. The actual native view is a plain ViewManager, NOT
 * a Nitro HybridView — getHostComponent is only used for JS-side view config
 * registration since it properly handles RN 0.81 bridgeless mode.
 */
export const NitroVLCView: any = getHostComponent<any, any>(
  'NitroVLCView',
  () => ({
    uiViewClassName: 'NitroVLCView',
    supportsRawText: false,
    bubblingEventTypes: {},
    directEventTypes: {},
    validAttributes: {
      viewId: true,
    },
  }),
)

export const NitroVLCModule = NitroModules.createHybridObject<NitroVLCModuleType>('NitroVLCModule')

export type {
  NitroVLCMethods,
  OnPlayingEventProps,
  OnProgressEventProps,
  PlayerAspectRatio,
  PlayerResizeMode,
  SimpleCallbackEventProps,
  Track,
  VideoInfo,
  VLCPlayerSource,
  VideoSize,
} from './NitroVLC.nitro'

export type { NitroVLCModule as NitroVLCModuleType } from './NitroVLCModule.nitro'
