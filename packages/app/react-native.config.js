module.exports = {
  assets: [
    // Only the icon families the app imports — linking the whole Fonts dir
    // ships ~3.6 MB of unused TTFs (see plugins/withVectorIconFonts.js).
    './node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Feather.ttf',
    './node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf',
  ],
}
