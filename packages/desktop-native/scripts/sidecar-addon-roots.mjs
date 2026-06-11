import fs from 'fs'
import path from 'path'

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

export function getSidecarAddonRoots(repoRoot) {
  const candidates = [
    path.join(repoRoot, 'packages', 'backend', 'node_modules', 'bare-ffmpeg'),
    path.join(repoRoot, 'packages', 'bare-ffmpeg'),
  ]

  return candidates.filter(isDirectory)
}
