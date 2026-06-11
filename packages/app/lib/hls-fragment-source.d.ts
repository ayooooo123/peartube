export interface HlsSegment {
  uri: string
  duration: number
  start: number
}

export interface ParsedMediaPlaylist {
  initUri: string | null
  segments: HlsSegment[]
  ended: boolean
  mediaSequence: number
  targetDuration: number
}

export function resolveAgainstPlaylist(playlistUrl: string, uri: string | null | undefined): string | null
export function isMasterPlaylist(text: unknown): boolean
export function parseMasterPlaylist(text: unknown): string | null
export function parseMediaPlaylist(text: unknown): ParsedMediaPlaylist
export function findSegmentIndexForTime(segments: HlsSegment[] | null | undefined, time: number): number
export function buildCompatMimeCandidates(videoCodecString?: string | null): string[]
