export default {
  app: {
    name: 'PearTube',
    identifier: 'com.peartube.desktop',
    version: '0.1.115',
  },
  build: {
    bunVersion: '1.3.11',
    bun: {
      entrypoint: 'src/bun/index.ts',
    },
    views: {
      app: {
        entrypoint: 'src/view/index.ts',
      },
    },
    copy: {},
    mac: {
      defaultRenderer: 'native',
    },
  },
}
