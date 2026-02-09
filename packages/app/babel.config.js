const path = require('path')

module.exports = function (api) {
  api.cache(true)
  const isPearWebExport = process.env.PEARTUBE_WEB_EXPORT === '1'
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    plugins: [
      isPearWebExport && 'react-native-web',
      [
        'module-resolver',
        {
          root: ['./'],
          alias: {
            '@': './',
            '@/components': './components',
            '@/app': './app',
            'react-native-css-interop/jsx-runtime': path.resolve(__dirname, 'node_modules/react-native-css-interop/dist/runtime/jsx-runtime'),
            'react-native-css-interop/jsx-dev-runtime': path.resolve(__dirname, 'node_modules/react-native-css-interop/dist/runtime/jsx-dev-runtime'),
          },
        },
      ],
      'react-native-reanimated/plugin',
    ].filter(Boolean),
  }
}
