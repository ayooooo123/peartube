#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ios = dirname(fileURLToPath(import.meta.url))
const root = dirname(ios)
const { version } = JSON.parse(readFileSync(join(root, 'package.json')))
const config = {
  name: 'PearTube',
  options: { deploymentTarget: { iOS: '17.0' }, createIntermediateGroups: true },
  settings: { base: {
    SWIFT_VERSION: '5.0', IPHONEOS_DEPLOYMENT_TARGET: '17.0', TARGETED_DEVICE_FAMILY: '1,2',
    MARKETING_VERSION: version, CURRENT_PROJECT_VERSION: version,
    ENABLE_USER_SCRIPT_SANDBOXING: 'NO', CLANG_ENABLE_MODULES: 'YES',
    CODE_SIGN_STYLE: 'Automatic',
    PRODUCT_BUNDLE_IDENTIFIER: 'com.peartube.app.dev',
    SUPPORTED_PLATFORMS: 'iphoneos iphonesimulator',
    SUPPORTS_MACCATALYST: 'NO'
  } },
  targets: {
    PearTube: {
      type: 'application', platform: 'iOS', sources: ['App', 'Runtime'],
      dependencies: [{ framework: 'build/native/PearTubeNative.xcframework', embed: false }],
      settings: { base: {
        LIBRARY_SEARCH_PATHS: ['$(inherited)', '$(SRCROOT)/build/$(PLATFORM_NAME)'],
        SWIFT_OBJC_BRIDGING_HEADER: 'Runtime/PearTube-Bridging-Header.h',
        OTHER_LDFLAGS: ['$(inherited)', '-lpeartube_ios', '-lc++', '-liconv', '-lz', '-framework AVFoundation', '-framework AudioToolbox', '-framework CoreAudio', '-framework CoreMedia', '-framework CoreVideo', '-framework QuartzCore', '-framework CoreGraphics', '-framework Foundation', '-framework UIKit', '-framework Security', '-framework VideoToolbox', '-framework SystemConfiguration'],
        LD_RUNPATH_SEARCH_PATHS: ['$(inherited)', '@executable_path/Frameworks']
      } },
      info: { path: 'build/Info.plist', properties: {
        CFBundleDisplayName: 'PearTube', CFBundleVersion: '$(CURRENT_PROJECT_VERSION)', CFBundleShortVersionString: '$(MARKETING_VERSION)',
        UILaunchScreen: {}, NSLocalNetworkUsageDescription: 'PearTube discovers nearby peers and TV receivers on your Wi-Fi network.',
        NSCameraUsageDescription: 'Scan PearTube channel and TV pairing QR codes.',
        NSBonjourServices: ['_hyperdht-mdns._udp', '_peartube-cast._tcp'],
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
        CFBundleURLTypes: [{ CFBundleURLName: 'PearTube', CFBundleURLSchemes: ['peartube'] }],
        UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
        'UISupportedInterfaceOrientations~ipad': ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
        UIRequiresFullScreen: true
      } },
      preBuildScripts: [{ name: 'Prepare P2P backend and Rust player', script: 'set -eu\nexport PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:$PATH"\nnode "$SRCROOT/prepare.mjs" "$PLATFORM_NAME"', basedOnDependencyAnalysis: false }]
    },
    PearTubeUITests: {
      type: 'bundle.ui-testing', platform: 'iOS', sources: ['UITests', { path: process.env.PEARTUBE_E2E_FIXTURE || 'build/private-e2e/fixture.json', type: 'file', buildPhase: 'resources', optional: true, createIntermediateGroups: false }],
      dependencies: [{ target: 'PearTube' }],
      settings: { base: { PRODUCT_BUNDLE_IDENTIFIER: 'com.peartube.app.dev.uitests', GENERATE_INFOPLIST_FILE: 'YES' } }
    }
  },
  schemes: { PearTube: { build: { targets: { PearTube: 'all', PearTubeUITests: ['test'] } }, test: { targets: ['PearTubeUITests'], gatherCoverageData: false } } }
}
mkdirSync(join(ios, 'build'), { recursive: true })
// xcodegen resolves the xcframework path, so it must exist before generating.
execFileSync('sh', ['ios/native.sh'], { cwd: root, stdio: 'inherit' })
writeFileSync(join(ios, 'project.generated.json'), JSON.stringify(config, null, 2))
execFileSync('xcodegen', ['generate', '--spec', 'project.generated.json', '--project', '.'], { cwd: ios, stdio: 'inherit', timeout: 60000 })
