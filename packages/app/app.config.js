// Expo config. `app.json` holds everything static; the app version comes from
// `package.json` so that one number drives all of:
//   - the native build (Expo writes it to iOS CFBundleShortVersionString and
//     Android versionName during prebuild)
//   - the Pear OTA payload manifest that `pear-mobile` compares against
//   - the manifest `pear-runtime-react-native` boot control reads at launch
//
// Native and OTA releases share one increasing SemVer sequence, so a second
// version field anywhere else is a way to ship an OTA that a store build then
// loses to. Do not add `version` back to `app.json`.
const app = require('./app.json')
const { version } = require('./package.json')

module.exports = { ...app.expo, version }
