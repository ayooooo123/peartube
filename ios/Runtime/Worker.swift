import Foundation
import PearTubeNative

struct WorkerError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// The backend's line callback runs on the library's output thread; this box carries its lines to
/// the main queue.
private final class LineBox {
    let onLine: (Data) -> Void
    init(_ onLine: @escaping (Data) -> Void) { self.onLine = onLine }
}

/// The callback's bytes are borrowed and valid only inside the call, so they are copied here.
private let lineTrampoline: pt_line_cb = { user, bytes, length in
    guard let user, let bytes else { return }
    let box = Unmanaged<LineBox>.fromOpaque(user).takeUnretainedValue()
    box.onLine(Data(bytes: bytes, count: length))
}

/// The P2P backend over the C ABI (peartube-native-ffi). It speaks `worklet/worker.js`'s
/// newline-delimited JSON unchanged; only the transport differs from the worklet it replaced.
@MainActor
final class Worker {
    var onEvent: (([String: Any]) -> Void)?
    private let bonjour = BonjourHost()
    private var box: LineBox?
    private var handle: UnsafeMutableRawPointer?
    private var nextID = 0
    private var requests: [Int: CheckedContinuation<Any, Error>] = [:]
    private var suspended = false
    private var closed = false

    init() throws {
        let abi = pt_abi_version()
        guard abi == UInt32(PT_ABI_VERSION) else {
            throw WorkerError(message: "This build links an incompatible PearTube backend (ABI \(abi)).")
        }
        let box = LineBox { [weak self] data in DispatchQueue.main.async { self?.receive(data) } }
        self.box = box
        let config = Data(#"{"bonjour":"host"}"#.utf8)
        var handle: UnsafeMutableRawPointer?
        let status = config.withUnsafeBytes { raw in
            pt_init(raw.bindMemory(to: UInt8.self).baseAddress, config.count, lineTrampoline, Unmanaged.passUnretained(box).toOpaque(), &handle)
        }
        guard status == PT_OK, let handle else {
            throw WorkerError(message: "Cannot start the embedded P2P backend (status \(status)).")
        }
        self.handle = handle
        NSLog("PearTube Rust peer engine started (ABI %u)", abi)
        // Host events (the system Bonjour adapter) travel back as `{event}` lines.
        bonjour.send = { [weak self] message in self?.send(message) }
    }

    func request(_ method: String, _ params: [String: Any] = [:]) async throws -> Any {
        guard !closed else { throw WorkerError(message: "The P2P worker is closed.") }
        nextID += 1
        let id = nextID
        return try await withCheckedThrowingContinuation { continuation in
            requests[id] = continuation
            do {
                var data = try JSONSerialization.data(withJSONObject: ["id": id, "method": method, "params": params])
                data.append(10)
                try write(data)
            } catch {
                requests.removeValue(forKey: id)
                continuation.resume(throwing: error)
            }
        }
    }

    private func send(_ message: [String: Any]) {
        guard !closed else { return }
        do {
            var data = try JSONSerialization.data(withJSONObject: message)
            data.append(10)
            try write(data)
        } catch { fail(error.localizedDescription) }
    }

    private func write(_ data: Data) throws {
        guard let handle else { throw WorkerError(message: "The P2P backend is closed.") }
        let status = data.withUnsafeBytes { pt_send_line(handle, $0.bindMemory(to: UInt8.self).baseAddress, data.count) }
        guard status == PT_OK else { throw WorkerError(message: "The P2P backend rejected a message (status \(status)).") }
    }

    // The ABI delivers exactly one complete line per callback, with no terminator.
    private func receive(_ line: Data) {
        guard !line.isEmpty else { return }
        do {
            guard let message = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                throw WorkerError(message: "The P2P worker sent an invalid message.")
            }
            if let event = message["event"] as? String {
                if event == "bonjour" { bonjour.handle(message) }
                else if event == "fatal" { fail(message["error"] as? String ?? "P2P runtime failed") }
                else { onEvent?(message) }
            } else if let id = message["id"] as? Int, let continuation = requests.removeValue(forKey: id) {
                if let error = message["error"] as? String { continuation.resume(throwing: WorkerError(message: error)) }
                else { continuation.resume(returning: message["result"] ?? NSNull()) }
            }
        } catch { fail(error.localizedDescription) }
    }

    private func fail(_ message: String) {
        let waiting = requests
        requests.removeAll()
        for continuation in waiting.values { continuation.resume(throwing: WorkerError(message: message)) }
        onEvent?(["event": "fatal", "error": message])
    }

    func suspend() {
        guard !closed, !suspended, let handle else { return }
        suspended = true
        pt_suspend(handle, 5000)
    }

    func resume() {
        guard !closed, suspended, let handle else { return }
        suspended = false
        pt_resume(handle)
    }

    func refreshDiscovery() {
        guard !closed else { return }
        bonjour.refreshBrowsers()
    }

    func close() {
        guard !closed else { return }
        bonjour.close()
        closed = true
        if let handle { pt_shutdown(handle) }
        box = nil
        // All callbacks have submitted their lines to the main queue. Let those replies
        // complete their requests before failing any that the engine did not answer.
        DispatchQueue.main.async { self.fail("The P2P worker was closed.") }
        handle = nil
    }

    deinit {
        if let handle { withExtendedLifetime(box) { pt_shutdown(handle) } }
    }
}
