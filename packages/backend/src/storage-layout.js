function createArchiveDirPath(storagePath, pathModule, fsModule, prefix = 'logs-legacy') {
  const dbDir = pathModule.join(storagePath, 'db')
  const baseName = `${prefix}-${Date.now()}`
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

export function relocateLegacyBlindPeerDir(storagePath, fsModule, pathModule) {
  if (!storagePath || !fsModule || !pathModule) return null

  const legacyBlindPeerDir = pathModule.join(storagePath, 'blind-peer')
  const corestoreBlindPeerDir = pathModule.join(storagePath, 'corestore', 'blind-peer')
  const dbBlindPeerDir = pathModule.join(storagePath, 'db', 'blind-peer')

  let legacyStats = null
  try {
    legacyStats = fsModule.statSync(legacyBlindPeerDir)
  } catch {}

  if (!legacyStats?.isDirectory?.()) return null
  fsModule.mkdirSync(pathModule.dirname(corestoreBlindPeerDir), { recursive: true })

  if (!fsModule.existsSync(corestoreBlindPeerDir) && !fsModule.existsSync(dbBlindPeerDir)) {
    fsModule.renameSync(legacyBlindPeerDir, corestoreBlindPeerDir)
    return corestoreBlindPeerDir
  }

  fsModule.mkdirSync(pathModule.join(storagePath, 'db'), { recursive: true })
  const archiveDir = createArchiveDirPath(storagePath, pathModule, fsModule, 'blind-peer-legacy')
  moveDirectoryContents(legacyBlindPeerDir, archiveDir, fsModule, pathModule)
  fsModule.rmdirSync(legacyBlindPeerDir)
  return archiveDir
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
