function createArchiveDirPath(storagePath, pathModule, fsModule) {
  const dbDir = pathModule.join(storagePath, 'db')
  const baseName = `logs-legacy-${Date.now()}`
  let candidate = pathModule.join(dbDir, baseName)
  let counter = 1

  while (fsModule.existsSync(candidate)) {
    candidate = pathModule.join(dbDir, `${baseName}-${counter++}`)
  }

  return candidate
}

function moveFileWithFallback(srcPath, destPath, fsModule) {
  try {
    fsModule.renameSync(srcPath, destPath)
    return
  } catch {}

  const contents = fsModule.readFileSync(srcPath)
  fsModule.writeFileSync(destPath, contents)
  fsModule.unlinkSync(srcPath)
}

function moveDirectoryContents(srcDir, destDir, fsModule, pathModule) {
  fsModule.mkdirSync(destDir, { recursive: true })

  for (const entryName of fsModule.readdirSync(srcDir)) {
    const srcPath = pathModule.join(srcDir, entryName)
    const destPath = pathModule.join(destDir, entryName)
    const stats = fsModule.statSync(srcPath)

    if (stats.isDirectory()) {
      moveDirectoryContents(srcPath, destPath, fsModule, pathModule)
      fsModule.rmdirSync(srcPath)
      continue
    }

    moveFileWithFallback(srcPath, destPath, fsModule)
  }
}

export function relocateLegacyLogsDir(storagePath, fsModule, pathModule) {
  if (!storagePath || !fsModule || !pathModule) return null

  const legacyLogsDir = pathModule.join(storagePath, 'logs')
  const dbLogsDir = pathModule.join(storagePath, 'db', 'logs')

  let legacyStats = null
  try {
    legacyStats = fsModule.statSync(legacyLogsDir)
  } catch {}

  if (!legacyStats?.isDirectory?.()) return null
  if (!fsModule.existsSync(dbLogsDir)) return null

  const archiveDir = createArchiveDirPath(storagePath, pathModule, fsModule)
  moveDirectoryContents(legacyLogsDir, archiveDir, fsModule, pathModule)
  fsModule.rmdirSync(legacyLogsDir)
  return archiveDir
}
