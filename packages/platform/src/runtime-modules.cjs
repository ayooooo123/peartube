// Keep optional native dependencies synchronous and lazy for Bare and Metro.
exports.loadReactNativeModuleSync = function loadReactNativeModuleSync() {
  return require('react-native')
}

exports.loadBareStorageModuleSync = function loadBareStorageModuleSync() {
  return require('bare-storage')
}
