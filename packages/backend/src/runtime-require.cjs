exports.requireOptionalModule = function requireOptionalModule(specifier) {
  try {
    return require(specifier)
  } catch {
    return null
  }
}
