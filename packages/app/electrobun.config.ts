import { version } from './package.json'

export default {
  app: {
    name: 'PearTube',
    identifier: 'com.peartube.desktop',
    // Single SemVer source: package.json `version` is what the release
    // workflow bumps, what the mobile build ships, and what the Pear updater
    // compares against the staged payload's package.json. Never hardcode it
    // here — a desktop bundle whose version disagrees with the OTA manifest
    // either re-downloads forever or never updates at all.
    version,
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
