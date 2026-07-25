import { useMemo } from 'react'
import { Platform, Share } from 'react-native'
import { useRouter } from 'expo-router'
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system/legacy'
import { MigrationBackupPanel } from '@/components/maintenance/MigrationBackupPanel'
import { useApp } from './_layout'
import { saveBytesToFile, selectBytesFromFile, type SelectedFile } from '@/lib/maintenance-file-transfer.mjs'
import type { MaintenanceFiles } from '@/components/maintenance/maintenance-model.mjs'

async function writeNativeExport(fileName: string, base64: string, mimeType: string): Promise<string> {
  if (Platform.OS === 'android') {
    const permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync()
    if (!permission.granted) throw new Error('File export cancelled')
    const uri = await FileSystem.StorageAccessFramework.createFileAsync(permission.directoryUri, fileName, mimeType)
    await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 })
    return uri
  }
  if (!FileSystem.documentDirectory) throw new Error('Native file export is unavailable')
  const uri = `${FileSystem.documentDirectory}${fileName}`
  await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 })
  return uri
}

async function shareNativeExport(uri: string, fileName: string): Promise<void> {
  if (Platform.OS === 'android' && uri.startsWith('content://')) return
  await Share.share({ title: fileName, url: uri })
}

async function readNativeImport(uri: string, maxBytes: number): Promise<string> {
  const info = await FileSystem.getInfoAsync(uri)
  if (!info.exists) throw new Error('Selected file could not be read')
  if (typeof info.size === 'number' && info.size > maxBytes) {
    throw new Error(`File is too large (maximum ${maxBytes} bytes)`)
  }
  return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
}

export default function MaintenanceScreen() {
  const router = useRouter()
  const { rpc } = useApp()
  const files = useMemo<MaintenanceFiles>(() => ({
    save: (file) => saveBytesToFile({
      platform: Platform.OS,
      ...file,
      native: { writeBase64File: writeNativeExport, shareFile: shareNativeExport },
    }),
    select: async ({ maxBytes }): Promise<SelectedFile | null> => selectBytesFromFile({
      platform: Platform.OS,
      maxBytes,
      pickDocument: () => DocumentPicker.getDocumentAsync({
        type: 'application/json',
        copyToCacheDirectory: true,
        multiple: false,
      }),
      native: { readBase64File: readNativeImport },
    }),
  }), [])

  return <MigrationBackupPanel rpc={rpc} files={files} onBack={() => router.back()} />
}
