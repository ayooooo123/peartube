export function assessArchiveConfidence(input = {}) {
  const ownDevice = (input.ownDeviceCopies || []).some(copy => copy && copy.sameDevice !== true)
  const archivist = (input.archivistChallenges || []).some(challenge => challenge?.recent && challenge?.passed)
  const eligible = ownDevice || archivist
  const reasons = []
  if (ownDevice) reasons.push('own-device-confirmed')
  if (archivist) reasons.push('archivist-challenge-confirmed')
  return { eligible, reasons, viewerFullCopies: Math.max(0, Number(input.viewerFullCopies) || 0) }
}
