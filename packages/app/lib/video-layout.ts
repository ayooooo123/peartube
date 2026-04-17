export function getPlayerPageVideoHeight(screenWidth: number) {
  return Math.round(screenWidth * 9 / 16)
}

export function getDesktopVideoGridColumns(isDesktop: boolean, screenWidth: number): number {
  if (!isDesktop) return 1
  if (screenWidth >= 1400) return 4
  if (screenWidth >= 1100) return 3
  if (screenWidth >= 800) return 2
  return 1
}
