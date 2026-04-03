import fs from 'fs'
import path from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

const packageRoot = path.resolve(import.meta.dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), 'utf8')
}

test('default desktop build does not hard-require BareKit at compile time', () => {
  const projectYml = read('project.yml')
  const embeddedSession = read('Sources/Support/EmbeddedBareKitSession.swift')
  const bareKitTests = read('Tests/BareKitIntegrationTests.swift')

  assert.doesNotMatch(
    projectYml,
    /SWIFT_OBJC_BRIDGING_HEADER/,
    'default desktop build should not require a BareKit bridging header'
  )
  assert.doesNotMatch(
    projectYml,
    /-framework BareKit/,
    'default desktop build should not hard-link BareKit'
  )
  assert.match(
    embeddedSession,
    /#if PEARTUBE_ENABLE_EMBEDDED_BAREKIT/,
    'embedded BareKit session should be compile-gated'
  )
  assert.match(
    bareKitTests,
    /#if PEARTUBE_ENABLE_EMBEDDED_BAREKIT/,
    'BareKit integration tests should be compile-gated'
  )
})

test('media extension lab app embeds the experimental format reader and decoder behind a dedicated scheme', () => {
  const projectYml = read('project.yml')

  assert.match(
    projectYml,
    /PearTubeMediaExtensionLabApp:/,
    'project should define a dedicated lab application target for MediaExtension experiments'
  )
  assert.match(
    projectYml,
    /target: PearTubeMediaFormatReader[\s\S]*embed: true[\s\S]*destination: plugins/,
    'lab app should embed the format reader appex into PlugIns'
  )
  assert.match(
    projectYml,
    /target: PearTubeSupplementalVideoDecoder[\s\S]*embed: true[\s\S]*destination: plugins/,
    'lab app should embed the video decoder appex into PlugIns'
  )
  assert.match(
    projectYml,
    /PearTubeMediaExtensionLab:[\s\S]*PEARTUBE_NATIVE_ENABLE_MEDIA_EXTENSIONS: "1"/,
    'lab scheme should enable MediaExtension registration'
  )
  assert.match(
    projectYml,
    /PearTubeMediaExtensionLab:[\s\S]*PEARTUBE_NATIVE_ENABLE_MEDIA_EXTENSION_ROUTING: "1"/,
    'lab scheme should enable experimental MediaExtension routing'
  )
})

test('media extension bundles declare the metadata and entitlements required for registration', () => {
  const formatReaderInfo = read('Extensions/MediaFormatReader/Resources/Info.plist')
  const formatReaderEntitlements = read('Extensions/MediaFormatReader/Resources/PearTubeMediaFormatReader.entitlements')
  const videoDecoderInfo = read('Extensions/MediaVideoDecoder/Resources/Info.plist')
  const videoDecoderEntitlements = read('Extensions/MediaVideoDecoder/Resources/PearTubeSupplementalVideoDecoder.entitlements')

  assert.match(
    formatReaderInfo,
    /<key>EXAppExtensionAttributes<\/key>[\s\S]*<string>com\.apple\.mediaextension\.formatreader<\/string>/,
    'format reader Info.plist should declare the MediaExtension format-reader extension point'
  )
  assert.match(
    formatReaderInfo,
    /<key>EXPrincipalClass<\/key>\s*<string>PTMediaFormatReaderExtension<\/string>/,
    'format reader Info.plist should name the format-reader principal class'
  )
  assert.match(
    formatReaderInfo,
    /<key>ClassImplementationID<\/key>\s*<string>com\.peartube\.mediaextension\.formatreader\.experimental<\/string>/,
    'format reader Info.plist should declare a stable format-reader implementation ID'
  )
  assert.match(
    formatReaderInfo,
    /<key>MTFileNameExtensionArray<\/key>[\s\S]*<string>mkv<\/string>[\s\S]*<string>webm<\/string>/,
    'format reader Info.plist should advertise MKV and WebM filename extensions'
  )
  assert.match(
    formatReaderInfo,
    /<key>MTUTTypeArray<\/key>[\s\S]*com\.peartube\.media\.matroska[\s\S]*com\.peartube\.media\.webm/,
    'format reader Info.plist should advertise exported UTTypes for Matroska and WebM'
  )
  assert.match(
    formatReaderEntitlements,
    /<key>com\.apple\.developer\.mediaextension\.formatreader<\/key>\s*<true\/>/,
    'format reader entitlements should enable the MediaExtension format-reader capability'
  )

  assert.match(
    videoDecoderInfo,
    /<key>EXAppExtensionAttributes<\/key>[\s\S]*<string>com\.apple\.mediaextension\.videodecoder<\/string>/,
    'video decoder Info.plist should declare the MediaExtension video-decoder extension point'
  )
  assert.match(
    videoDecoderInfo,
    /<key>EXPrincipalClass<\/key>\s*<string>PTSupplementalVideoDecoderExtension<\/string>/,
    'video decoder Info.plist should name the video-decoder principal class'
  )
  assert.match(
    videoDecoderInfo,
    /<key>ClassImplementationID<\/key>\s*<string>com\.peartube\.mediaextension\.videodecoder\.experimental<\/string>/,
    'video decoder Info.plist should declare a stable video-decoder implementation ID'
  )
  assert.match(
    videoDecoderInfo,
    /<key>CodecInfo<\/key>[\s\S]*<string>vp09<\/string>[\s\S]*<string>av01<\/string>/,
    'video decoder Info.plist should advertise VP9 and AV1 codec identifiers'
  )
  assert.match(
    videoDecoderEntitlements,
    /<key>com\.apple\.developer\.mediaextension\.videodecoder<\/key>\s*<true\/>/,
    'video decoder entitlements should enable the MediaExtension video-decoder capability'
  )
})
