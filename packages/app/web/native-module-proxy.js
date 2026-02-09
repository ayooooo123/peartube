/*
 * Shim React Native's bridged NativeModules for Metro web bundles.
 *
 * Expo SDK 54 + Metro web export can end up evaluating react-native's NativeModules
 * implementation in a browser context, which expects a native bridge to inject
 * `__fbBatchedBridgeConfig`.
 *
 * For Pear desktop we want the web runtime to boot without a native bridge.
 * Providing `globalThis.nativeModuleProxy` prevents react-native from trying to
 * read `__fbBatchedBridgeConfig`.
 */

let UIManager = null
try {
  // Prefer react-native-web's UIManager implementation.
  const mod = require('react-native-web/dist/exports/UIManager')
  UIManager = mod?.default ?? mod
} catch {
  UIManager = null
}

function getWindowDimensions() {
  const scale = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1
  const width = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 0
  const height = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 0
  return { width, height, scale, fontScale: scale }
}

const DeviceInfo = {
  getConstants() {
    const dims = getWindowDimensions()
    return {
      Dimensions: {
        window: dims,
        screen: dims,
      },
    }
  },
}

const SourceCode = {
  getConstants() {
    const scriptURL = typeof location !== 'undefined' ? String(location.href) : ''
    return { scriptURL }
  },
}

const UIManagerModule = UIManager
  ? {
      ...UIManager,
      getConstants: UIManager.getConstants ?? (() => ({ ViewManagerNames: [] })),
      getViewManagerConfig: UIManager.getViewManagerConfig ?? (() => null),
      getConstantsForViewManager: UIManager.getConstantsForViewManager ?? (() => null),
      getDefaultEventTypes: UIManager.getDefaultEventTypes ?? (() => ({})),
    }
  : {
      getConstants: () => ({ ViewManagerNames: [] }),
      getViewManagerConfig: () => null,
      getConstantsForViewManager: () => null,
      getDefaultEventTypes: () => ({}),
    }

globalThis.nativeModuleProxy = {
  DeviceInfo,
  SourceCode,
  UIManager: UIManagerModule,
}

globalThis.__PEARTUBE_NATIVE_MODULE_PROXY__ = true
