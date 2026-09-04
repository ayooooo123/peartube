/* eslint-disable @typescript-eslint/no-require-imports */
const { withAppBuildGradle, withSettingsGradle } = require('@expo/config-plugins')

const settingsNodeResolverBlock = `  def resolveNodeExecutable = {
    def configured = providers.gradleProperty("nodeExecutable").orNull ?: System.getenv("NODE_BINARY")
    if (configured != null && configured.toString().trim()) return configured.toString()

    def pathEnv = System.getenv("PATH") ?: ""
    for (def entry : pathEnv.split(File.pathSeparator)) {
      if (!entry) continue
      def candidate = new File(entry, "node")
      if (candidate.canExecute()) return candidate.absolutePath
    }

    for (def candidatePath : ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
      def candidate = new File(candidatePath)
      if (candidate.canExecute()) return candidate.absolutePath
    }

    throw new GradleException("Node.js executable was not found. Set NODE_BINARY or -PnodeExecutable to an absolute node path.")
  }
  def nodeExecutable = resolveNodeExecutable()
`

const appBuildNodeResolverBlock = `def resolveNodeExecutable = {
    def configured = findProperty("nodeExecutable") ?: System.getenv("NODE_BINARY")
    if (configured != null && configured.toString().trim()) return configured.toString()

    def pathEnv = System.getenv("PATH") ?: ""
    for (def entry : pathEnv.split(File.pathSeparator)) {
        if (!entry) continue
        def candidate = new File(entry, "node")
        if (candidate.canExecute()) return candidate.absolutePath
    }

    for (def candidatePath : ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
        def candidate = new File(candidatePath)
        if (candidate.canExecute()) return candidate.absolutePath
    }

    throw new GradleException("Node.js executable was not found. Set NODE_BINARY or -PnodeExecutable to an absolute node path.")
}

def nodeExecutable = resolveNodeExecutable()
def nodeCommand = { List args -> [nodeExecutable] + args }
`

function patchSettingsGradle(source) {
  let next = source
  if (!next.includes('def resolveNodeExecutable = {')) {
    next = next.replace('pluginManagement {\n', `pluginManagement {\n${settingsNodeResolverBlock}`)
  }
  next = next.replaceAll('commandLine("node",', 'commandLine(nodeExecutable,')
  return next
}

function patchAppBuildGradle(source) {
  let next = source
  if (!next.includes('def resolveNodeExecutable = {')) {
    next = next.replace(
      'def projectRoot = rootDir.getAbsoluteFile().getParentFile().getAbsolutePath()\n',
      `def projectRoot = rootDir.getAbsoluteFile().getParentFile().getAbsolutePath()\n\n${appBuildNodeResolverBlock}\n`,
    )
  }

  const replacements = [
    [
      '["node", "-e", "require(\'expo/scripts/resolveAppEntry\')", projectRoot, "android", "absolute"].execute(null, rootDir).text.trim()',
      'nodeCommand(["-e", "require(\'expo/scripts/resolveAppEntry\')", projectRoot, "android", "absolute"]).execute(null, rootDir).text.trim()',
    ],
    [
      '["node", "--print", "require.resolve(\'react-native/package.json\')"].execute(null, rootDir).text.trim()',
      'nodeCommand(["--print", "require.resolve(\'react-native/package.json\')"]).execute(null, rootDir).text.trim()',
    ],
    [
      '["node", "--print", "require.resolve(\'hermes-compiler/package.json\', { paths: [require.resolve(\'react-native/package.json\')] })"].execute(null, rootDir).text.trim()',
      'nodeCommand(["--print", "require.resolve(\'hermes-compiler/package.json\', { paths: [require.resolve(\'react-native/package.json\')] })"]).execute(null, rootDir).text.trim()',
    ],
    [
      '["node", "--print", "require.resolve(\'@react-native/codegen/package.json\', { paths: [require.resolve(\'react-native/package.json\')] })"].execute(null, rootDir).text.trim()',
      'nodeCommand(["--print", "require.resolve(\'@react-native/codegen/package.json\', { paths: [require.resolve(\'react-native/package.json\')] })"]).execute(null, rootDir).text.trim()',
    ],
    [
      '["node", "--print", "require.resolve(\'@expo/cli\', { paths: [require.resolve(\'expo/package.json\')] })"].execute(null, rootDir).text.trim()',
      'nodeCommand(["--print", "require.resolve(\'@expo/cli\', { paths: [require.resolve(\'expo/package.json\')] })"]).execute(null, rootDir).text.trim()',
    ],
  ]

  for (const [needle, replacement] of replacements) next = next.split(needle).join(replacement)
  next = next.replaceAll('commandLine "node",', 'commandLine nodeExecutable,')
  if (!next.includes('nodeExecutableAndArgs = [nodeExecutable]')) {
    next = next.replace('    bundleCommand = "export:embed"\n', '    bundleCommand = "export:embed"\n    nodeExecutableAndArgs = [nodeExecutable]\n')
  }
  return next
}

function withAndroidNodeResolver(config) {
  config = withSettingsGradle(config, config => {
    config.modResults.contents = patchSettingsGradle(config.modResults.contents)
    return config
  })

  return withAppBuildGradle(config, config => {
    config.modResults.contents = patchAppBuildGradle(config.modResults.contents)
    return config
  })
}

module.exports = withAndroidNodeResolver
module.exports._patchSettingsGradle = patchSettingsGradle
module.exports._patchAppBuildGradle = patchAppBuildGradle
