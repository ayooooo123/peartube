import Foundation

struct WorkerError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// The P2P worker over bare-kit-swift (Runtime/BareKit). Writes go one at a time from `writes`, so
/// lines reach the worklet in the order they were sent.
@MainActor
final class Worker {
    var onEvent: (([String: Any]) -> Void)?
    private var worklet: Worklet?
    private var ipc: IPC?
    private let bonjour = BonjourHost()
    private var pending = Data()
    private var nextID = 0
    private var requests: [Int: CheckedContinuation<Any, Error>] = [:]
    private var writes: [Data] = []
    private var writing = false
    private var suspended = false
    private var closed = false

    init() throws {
        guard let bundle = Bundle.main.url(forResource: "worker", withExtension: "bundle") else {
            throw WorkerError(message: "The PearTube worklet is missing from this app.")
        }
        let source = try Data(contentsOf: bundle)
        let worklet: Worklet
        let ipc: IPC
        do {
            worklet = try Worklet()
            // The ipc exists before the worker runs, so nothing it writes at start is missed.
            ipc = try IPC(worklet: worklet)
            try worklet.start("/worker.bundle", source: source)
        } catch {
            throw WorkerError(message: "Cannot start the embedded P2P runtime: \(error)")
        }
        self.worklet = worklet
        self.ipc = ipc
        bonjour.send = { [weak self] message in self?.send(message) }
        Task { [weak self] in
            for await data in ipc { self?.receive(data) }
            guard let self, !self.closed else { return }
            self.fail("The embedded P2P worker closed its connection.")
        }
    }

    func request(_ method: String, _ params: [String: Any] = [:]) async throws -> Any {
        guard !closed else { throw WorkerError(message: "The P2P worker is closed.") }
        nextID += 1
        let id = nextID
        var data = try JSONSerialization.data(withJSONObject: ["id": id, "method": method, "params": params])
        data.append(10)
        return try await withCheckedThrowingContinuation { continuation in
            requests[id] = continuation
            writes.append(data)
            flush()
        }
    }

    private func send(_ message: [String: Any]) {
        guard !closed else { return }
        do {
            var data = try JSONSerialization.data(withJSONObject: message)
            data.append(10)
            writes.append(data)
            flush()
        } catch { fail(error.localizedDescription) }
    }

    private func flush() {
        guard !writing, !writes.isEmpty, let ipc, !closed else { return }
        writing = true
        let data = writes.removeFirst()
        Task { [weak self] in
            do {
                try await ipc.write(data)
                guard let self, !self.closed else { return }
                self.writing = false
                self.flush()
            } catch {
                guard let self, !self.closed else { return }
                self.writing = false
                self.fail(error.localizedDescription)
            }
        }
    }

    private func receive(_ data: Data) {
        guard !closed else { return }
        pending.append(data)
        while let newline = pending.firstIndex(of: 10) {
            let line = Data(pending[..<newline])
            pending.removeSubrange(...newline)
            if line.isEmpty { continue }
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
    }

    private func fail(_ message: String) {
        let waiting = requests
        requests.removeAll()
        for continuation in waiting.values { continuation.resume(throwing: WorkerError(message: message)) }
        onEvent?(["event": "fatal", "error": message])
    }

    func suspend() {
        guard !closed, !suspended else { return }
        suspended = true
        worklet?.suspend(linger: 5000)
    }

    func resume() {
        guard !closed, suspended else { return }
        suspended = false
        worklet?.resume()
    }

    func refreshDiscovery() {
        guard !closed else { return }
        bonjour.refreshBrowsers()
    }

    func close() {
        guard !closed else { return }
        bonjour.close()
        closed = true
        fail("The P2P worker was closed.")
        ipc?.close()
        ipc = nil
        // Releasing the worklet terminates it without blocking.
        worklet = nil
    }
}
