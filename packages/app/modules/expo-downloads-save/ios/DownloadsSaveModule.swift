import ExpoModulesCore

public class DownloadsSaveModule: Module {
    public func definition() -> ModuleDefinition {
        Name("DownloadsSave")

        AsyncFunction("saveToDownloads") { (sourceFilePath: String, filename: String, mimeType: String, promise: Promise) in
            self.saveFileToDownloads(sourceFilePath: sourceFilePath, filename: filename, mimeType: mimeType, promise: promise)
        }
    }

    private func saveFileToDownloads(sourceFilePath: String, filename: String, mimeType: String, promise: Promise) {
        let fileManager = FileManager.default

        // Check if source file exists
        guard fileManager.fileExists(atPath: sourceFilePath) else {
            promise.reject("FILE_NOT_FOUND", "Source file does not exist: \(sourceFilePath)")
            return
        }

        // On iOS, save to Documents directory (accessible via Files app)
        // This is the closest equivalent to a "Downloads" folder on iOS
        guard let documentsPath = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else {
            promise.reject("NO_DOCUMENTS_DIR", "Could not find Documents directory")
            return
        }

        let sourceURL = URL(fileURLWithPath: sourceFilePath)
        let destURL = documentsPath.appendingPathComponent(filename)

        do {
            // Remove existing file if present
            if fileManager.fileExists(atPath: destURL.path) {
                try fileManager.removeItem(at: destURL)
            }

            // If source and dest are the same directory, the file is already in place
            if sourceURL.deletingLastPathComponent().path == documentsPath.path {
                // File already in Documents, just return the path
                promise.resolve(sourceFilePath)
                return
            }

            try fileManager.copyItem(at: sourceURL, to: destURL)
            promise.resolve(destURL.path)
        } catch {
            promise.reject("SAVE_ERROR", "Failed to save file: \(error.localizedDescription)")
        }
    }
}
