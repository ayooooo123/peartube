import Foundation
import MPVKit

// MPVKit (edde746 fork, 0.40.0-no-lua) ships without stream_lavf, so mpv
// cannot open http:// URLs.  This bridge registers a custom "mpvhttp://"
// protocol via mpv_stream_cb_add_ro that fetches data with URLSession.
enum MpvHttpStreamBridge {

  static func register(mpv handle: OpaquePointer) {
    let status = mpv_stream_cb_add_ro(handle, "http", nil, mpvStreamOpen)
    if status < 0 {
      print("[MpvHttpStreamBridge] register failed: \(status)")
    }
  }
}

private final class MpvStreamContext {
  let url: URL
  let contentLength: Int64
  let session: URLSession
  var position: Int64 = 0
  var cancelled = false

  private static let readAheadSize: Int64 = 2 * 1024 * 1024
  private var readAheadBuf: Data = Data()
  private var readAheadStart: Int64 = 0

  init(url: URL, contentLength: Int64) {
    self.url = url
    self.contentLength = contentLength
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 30
    cfg.timeoutIntervalForResource = 300
    cfg.httpMaximumConnectionsPerHost = 4
    self.session = URLSession(configuration: cfg)
  }

  deinit {
    session.invalidateAndCancel()
  }

  func read(into dst: UnsafeMutablePointer<CChar>, maxBytes: Int) -> Int {
    if cancelled { return -1 }
    if contentLength >= 0 && position >= contentLength { return 0 }

    let bufEnd = readAheadStart + Int64(readAheadBuf.count)
    if position >= readAheadStart && position < bufEnd {
      let off = Int(position - readAheadStart)
      let n = min(maxBytes, readAheadBuf.count - off)
      readAheadBuf.withUnsafeBytes { ptr in
        dst.update(from: ptr.baseAddress!.advanced(by: off)
                        .assumingMemoryBound(to: CChar.self), count: n)
      }
      position += Int64(n)
      return n
    }

    let rangeEnd: Int64
    if contentLength >= 0 {
      rangeEnd = min(position + Self.readAheadSize - 1, contentLength - 1)
    } else {
      rangeEnd = position + Self.readAheadSize - 1
    }

    var req = URLRequest(url: url)
    req.setValue("bytes=\(position)-\(rangeEnd)", forHTTPHeaderField: "Range")

    let sem = DispatchSemaphore(value: 0)
    var fetched: Data?
    session.dataTask(with: req) { data, _, _ in
      fetched = data
      sem.signal()
    }.resume()
    sem.wait()

    if cancelled { return -1 }
    guard let data = fetched, !data.isEmpty else { return 0 }

    readAheadBuf = data
    readAheadStart = position

    let n = min(maxBytes, data.count)
    data.withUnsafeBytes { ptr in
      dst.update(from: ptr.baseAddress!.assumingMemoryBound(to: CChar.self), count: n)
    }
    position += Int64(n)
    return n
  }

  func seek(to offset: Int64) -> Int64 {
    if offset < 0 { return Int64(MPV_ERROR_GENERIC.rawValue) }
    if contentLength >= 0 && offset > contentLength {
      return Int64(MPV_ERROR_GENERIC.rawValue)
    }
    position = offset
    let bufEnd = readAheadStart + Int64(readAheadBuf.count)
    if offset < readAheadStart || offset >= bufEnd {
      readAheadBuf = Data()
      readAheadStart = offset
    }
    return offset
  }

  func size() -> Int64 {
    contentLength >= 0 ? contentLength : Int64(MPV_ERROR_UNSUPPORTED.rawValue)
  }
}

private func mpvStreamOpen(
  _: UnsafeMutableRawPointer?,
  uri: UnsafeMutablePointer<CChar>?,
  info: UnsafeMutablePointer<mpv_stream_cb_info>?
) -> Int32 {
  guard let uri, let info else { return Int32(MPV_ERROR_LOADING_FAILED.rawValue) }

  let uriStr = String(cString: uri)

  guard let url = URL(string: uriStr) else {
    return Int32(MPV_ERROR_LOADING_FAILED.rawValue)
  }

  var req = URLRequest(url: url)
  req.httpMethod = "GET"
  req.timeoutInterval = 10
  req.setValue("bytes=0-1", forHTTPHeaderField: "Range")

  let sem = DispatchSemaphore(value: 0)
  var contentLength: Int64 = -1
  var ok = false

  URLSession.shared.dataTask(with: req) { _, response, error in
    defer { sem.signal() }
    guard error == nil, let http = response as? HTTPURLResponse else { return }
    ok = (200...299).contains(http.statusCode) || http.statusCode == 206
    if let cr = http.value(forHTTPHeaderField: "Content-Range"),
       let slash = cr.lastIndex(of: "/") {
      contentLength = Int64(cr[cr.index(after: slash)...]) ?? -1
    } else if let cl = http.value(forHTTPHeaderField: "Content-Length") {
      contentLength = Int64(cl) ?? -1
    }
  }.resume()
  sem.wait()

  guard ok else {
    return Int32(MPV_ERROR_LOADING_FAILED.rawValue)
  }

  let ctx = MpvStreamContext(url: url, contentLength: contentLength)
  let cookie = Unmanaged.passRetained(ctx).toOpaque()

  info.pointee.cookie   = cookie
  info.pointee.read_fn  = mpvStreamRead
  info.pointee.seek_fn  = mpvStreamSeek
  info.pointee.size_fn  = mpvStreamSize
  info.pointee.close_fn = mpvStreamClose
  info.pointee.cancel_fn = mpvStreamCancel

  return 0
}

private func mpvStreamRead(
  cookie: UnsafeMutableRawPointer?,
  buf: UnsafeMutablePointer<CChar>?,
  nbytes: UInt64
) -> Int64 {
  guard let cookie, let buf else { return -1 }
  let ctx = Unmanaged<MpvStreamContext>.fromOpaque(cookie).takeUnretainedValue()
  return Int64(ctx.read(into: buf, maxBytes: Int(nbytes)))
}

private func mpvStreamSeek(
  cookie: UnsafeMutableRawPointer?,
  offset: Int64
) -> Int64 {
  guard let cookie else { return Int64(MPV_ERROR_GENERIC.rawValue) }
  let ctx = Unmanaged<MpvStreamContext>.fromOpaque(cookie).takeUnretainedValue()
  return ctx.seek(to: offset)
}

private func mpvStreamSize(cookie: UnsafeMutableRawPointer?) -> Int64 {
  guard let cookie else { return Int64(MPV_ERROR_UNSUPPORTED.rawValue) }
  let ctx = Unmanaged<MpvStreamContext>.fromOpaque(cookie).takeUnretainedValue()
  return ctx.size()
}

private func mpvStreamClose(cookie: UnsafeMutableRawPointer?) {
  guard let cookie else { return }
  Unmanaged<MpvStreamContext>.fromOpaque(cookie).release()
}

private func mpvStreamCancel(cookie: UnsafeMutableRawPointer?) {
  guard let cookie else { return }
  let ctx = Unmanaged<MpvStreamContext>.fromOpaque(cookie).takeUnretainedValue()
  ctx.cancelled = true
}
