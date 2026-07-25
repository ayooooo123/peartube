export type SavedFile = { fileName: string; uri: string; byteLength: number }
export type SelectedFile = { fileName: string; bytes: Uint8Array }

export function bytesToBase64(value: Uint8Array | ArrayBuffer | ArrayBufferView): string
export function base64ToBytes(value: string, maxBytes?: number): Uint8Array
export function saveBytesToFile(options: {
  platform: string
  bytes: Uint8Array | ArrayBuffer | ArrayBufferView
  fileName: string
  mimeType?: string
  web?: {
    createBlob(parts: Uint8Array[], options: { type: string }): unknown
    createObjectURL(blob: unknown): string
    revokeObjectURL(url: string): void
    clickDownload(url: string, fileName: string): void | Promise<void>
  }
  native?: {
    writeBase64File(fileName: string, base64: string, mimeType: string): Promise<string>
    shareFile(uri: string, fileName: string, mimeType: string): Promise<void>
  }
}): Promise<SavedFile>
export function selectBytesFromFile(options: {
  platform: string
  pickDocument(): Promise<unknown>
  maxBytes?: number
  native?: { readBase64File(uri: string, maxBytes: number): Promise<string> }
}): Promise<SelectedFile | null>
