package to.holepunch.modules.downloadssave

import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileInputStream
import java.io.IOException

class DownloadsSaveModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("DownloadsSave")

        AsyncFunction("saveToDownloads") { sourceFilePath: String, filename: String, mimeType: String, promise: Promise ->
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val result = saveFileToDownloads(sourceFilePath, filename, mimeType)
                    promise.resolve(result)
                } catch (e: Exception) {
                    promise.reject("SAVE_ERROR", e.message ?: "Failed to save file", e)
                }
            }
        }
    }

    private fun saveFileToDownloads(sourceFilePath: String, filename: String, mimeType: String): String {
        val context = appContext.reactContext
            ?: throw IOException("React context not available")

        val sourceFile = File(sourceFilePath)
        if (!sourceFile.exists()) {
            throw IOException("Source file does not exist: $sourceFilePath")
        }

        // Android 10+ uses MediaStore
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val contentValues = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, filename)
                put(MediaStore.Downloads.MIME_TYPE, mimeType)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }

            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, contentValues)
                ?: throw IOException("Failed to create MediaStore entry")

            try {
                resolver.openOutputStream(uri)?.use { outputStream ->
                    FileInputStream(sourceFile).use { inputStream ->
                        val buffer = ByteArray(8192)
                        var bytesRead: Int
                        while (inputStream.read(buffer).also { bytesRead = it } != -1) {
                            outputStream.write(buffer, 0, bytesRead)
                        }
                    }
                } ?: throw IOException("Failed to open output stream")

                // Mark as complete
                contentValues.clear()
                contentValues.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, contentValues, null, null)

                return uri.toString()
            } catch (e: Exception) {
                // Clean up on failure
                resolver.delete(uri, null, null)
                throw e
            }
        } else {
            // Android 9 and below - direct file access
            val downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            val destFile = File(downloadsDir, filename)

            FileInputStream(sourceFile).use { inputStream ->
                destFile.outputStream().use { outputStream ->
                    inputStream.copyTo(outputStream)
                }
            }

            return destFile.absolutePath
        }
    }
}
