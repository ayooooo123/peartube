package com.peartube.app

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Lightweight loopback-only (127.0.0.1) HTTP Range proxy that bridges HTTPS audio streams
 * (e.g., YouTube audio/mp4, direct HTTPS audio links) into PearTube's native Rust player
 * (`peartube-media` / AAudio), using chunked Range requests for fast startup and seeking.
 */
internal object LocalStreamProxy {
    private data class Target(
        val url: String,
        val userAgent: String,
        @Volatile var contentLength: Long = -1L,
        @Volatile var contentType: String = "audio/mp4",
    )

    private const val UPSTREAM_CHUNK_BYTES = 1024L * 1024L // 1 MiB chunks avoid upstream throttling
    private const val CONNECT_TIMEOUT_MS = 8_000
    private const val READ_TIMEOUT_MS = 15_000

    private val started = AtomicBoolean(false)
    private val targets = ConcurrentHashMap<String, Target>()
    private val pool = Executors.newCachedThreadPool()

    @Volatile
    private var serverPort: Int = 0

    @Volatile
    private var serverSocket: ServerSocket? = null

    fun register(httpsUrl: String, userAgent: String = ""): String {
        ensureStarted()
        val port = serverPort
        if (port <= 0) return httpsUrl
        // Keep the map bounded to recent streams.
        if (targets.size > 16) {
            targets.clear()
        }
        val token = UUID.randomUUID().toString().replace("-", "")
        targets[token] = Target(url = httpsUrl, userAgent = userAgent)
        return "http://127.0.0.1:$port/s/$token"
    }

    private fun ensureStarted() {
        if (started.get() && serverPort > 0) return
        synchronized(this) {
            if (started.get() && serverPort > 0) return
            val ss = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
            serverSocket = ss
            serverPort = ss.localPort
            started.set(true)
            val acceptThread = Thread(
                {
                    while (!ss.isClosed) {
                        val client = try {
                            ss.accept()
                        } catch (_: Exception) {
                            break
                        }
                        pool.execute { handleClient(client) }
                    }
                },
                "PearTubeStreamProxy",
            )
            acceptThread.isDaemon = true
            acceptThread.start()
        }
    }

    private fun handleClient(socket: Socket) {
        try {
            socket.soTimeout = 20_000
            socket.tcpNoDelay = true
            val input = BufferedInputStream(socket.getInputStream())
            val output = BufferedOutputStream(socket.getOutputStream(), 32 * 1024)

            val requestLine = readLine(input) ?: return
            val parts = requestLine.split(' ')
            if (parts.size < 2) return
            val method = parts[0].uppercase(Locale.ROOT)
            val rawPath = parts[1].substringBefore('?')

            var rangeHeader: String? = null
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon > 0) {
                    val key = line.substring(0, colon).trim().lowercase(Locale.ROOT)
                    if (key == "range") {
                        rangeHeader = line.substring(colon + 1).trim()
                    }
                }
            }

            if (method != "GET" && method != "HEAD") {
                writeSimpleStatus(output, 405, "Method Not Allowed")
                return
            }

            val token = rawPath.removePrefix("/s/").trim()
            val target = targets[token]
            if (target == null) {
                writeSimpleStatus(output, 404, "Not Found")
                return
            }

            // Probe total length once if unknown so Range headers and seeking work reliably.
            if (target.contentLength <= 0L) {
                probeTarget(target)
            }
            val total = target.contentLength
            val contentType = target.contentType

            if (method == "HEAD") {
                val sb = StringBuilder()
                sb.append("HTTP/1.1 200 OK\r\n")
                sb.append("Content-Type: $contentType\r\n")
                sb.append("Accept-Ranges: bytes\r\n")
                if (total > 0L) sb.append("Content-Length: $total\r\n")
                sb.append("Connection: close\r\n\r\n")
                output.write(sb.toString().toByteArray(Charsets.US_ASCII))
                output.flush()
                return
            }

            val requestedRange = parseRangeHeader(rangeHeader, total)
            if (requestedRange != null && total > 0L) {
                val (start, end) = requestedRange
                if (start < 0L || start >= total || end < start) {
                    writeSimpleStatus(output, 416, "Range Not Satisfiable")
                    return
                }
                // Cap each 206 span to 1 MiB (RFC 9110 §15.3.7 partial-span 206): oxideav-http
                // consumes the span and requests the next range on demand, avoiding wasted fetches
                // on seeks and letting us verify upstream HTTP status before writing headers.
                val spanEnd = minOf(end, start + UPSTREAM_CHUNK_BYTES - 1L)
                serveSingleSpan(target, start, spanEnd, total, contentType, output)
            } else {
                // Non-ranged request or unknown total length: direct passthrough.
                streamDirectPassthrough(target, rangeHeader, output)
            }
        } catch (_: Exception) {
            // Client closed socket on seek/stop or upstream interrupted; normal during playback.
        } finally {
            runCatching { socket.close() }
        }
    }

    private fun probeTarget(target: Target) {
        var conn: HttpURLConnection? = null
        try {
            conn = openUpstream(target, "bytes=0-1023")
            val code = conn.responseCode
            val ct = conn.contentType?.substringBefore(';')?.trim()
            if (!ct.isNullOrBlank()) {
                target.contentType = ct
            }
            if (code == 206) {
                val cr = conn.getHeaderField("Content-Range").orEmpty()
                val slash = cr.lastIndexOf('/')
                if (slash > 0) {
                    val parsedTotal = cr.substring(slash + 1).trim().toLongOrNull()
                    if (parsedTotal != null && parsedTotal > 0L) {
                        target.contentLength = parsedTotal
                    }
                }
            } else if (code == 200) {
                val cl = conn.contentLengthLong
                if (cl > 0L) {
                    target.contentLength = cl
                }
            }
            runCatching { conn.inputStream.close() }
        } catch (_: Exception) {
            // Ignore probe error; fallback to direct passthrough.
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    private fun serveSingleSpan(
        target: Target,
        start: Long,
        spanEnd: Long,
        total: Long,
        contentType: String,
        output: OutputStream,
    ) {
        var conn: HttpURLConnection? = null
        try {
            conn = openUpstream(target, "bytes=$start-$spanEnd")
            val code = conn.responseCode
            if (code != 206 && code != 200) {
                writeSimpleStatus(output, 502, "Bad Gateway")
                return
            }
            val expected = spanEnd - start + 1L
            val sb = StringBuilder()
            sb.append("HTTP/1.1 206 Partial Content\r\n")
            sb.append("Content-Type: $contentType\r\n")
            sb.append("Accept-Ranges: bytes\r\n")
            sb.append("Content-Range: bytes $start-$spanEnd/$total\r\n")
            sb.append("Content-Length: $expected\r\n")
            sb.append("Connection: close\r\n\r\n")
            output.write(sb.toString().toByteArray(Charsets.US_ASCII))
            output.flush()
            val buf = ByteArray(32 * 1024)
            var remaining = expected
            conn.inputStream.use { inp ->
                while (remaining > 0L) {
                    val toRead = minOf(buf.size.toLong(), remaining).toInt()
                    val n = inp.read(buf, 0, toRead)
                    if (n < 0) break
                    output.write(buf, 0, n)
                    remaining -= n.toLong()
                }
            }
            output.flush()
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    private fun streamDirectPassthrough(
        target: Target,
        rangeHeader: String?,
        output: OutputStream,
    ) {
        var conn: HttpURLConnection? = null
        try {
            conn = openUpstream(target, rangeHeader)
            val code = conn.responseCode
            if (code !in 200..299) {
                writeSimpleStatus(output, 502, "Bad Gateway")
                return
            }
            val ct = conn.contentType?.substringBefore(';')?.trim().orEmpty().ifBlank { target.contentType }
            val cl = conn.contentLengthLong
            val cr = conn.getHeaderField("Content-Range")
            val statusText = if (code == 206) "Partial Content" else "OK"
            val sb = StringBuilder()
            sb.append("HTTP/1.1 $code $statusText\r\n")
            sb.append("Content-Type: $ct\r\n")
            sb.append("Accept-Ranges: bytes\r\n")
            if (!cr.isNullOrBlank()) sb.append("Content-Range: $cr\r\n")
            if (cl > 0L) sb.append("Content-Length: $cl\r\n")
            sb.append("Connection: close\r\n\r\n")
            output.write(sb.toString().toByteArray(Charsets.US_ASCII))
            output.flush()
            val buf = ByteArray(32 * 1024)
            conn.inputStream.use { inp ->
                while (true) {
                    val n = inp.read(buf)
                    if (n < 0) break
                    output.write(buf, 0, n)
                }
            }
            output.flush()
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    private fun openUpstream(target: Target, range: String?): HttpURLConnection {
        return (URL(target.url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            instanceFollowRedirects = true
            setRequestProperty("Accept-Encoding", "identity")
            if (target.userAgent.isNotBlank()) {
                setRequestProperty("User-Agent", target.userAgent)
            }
            if (!range.isNullOrBlank()) {
                setRequestProperty("Range", range)
            }
        }
    }

    internal fun parseRangeHeader(raw: String?, total: Long): Pair<Long, Long>? {
        if (raw.isNullOrBlank() || total <= 0L) return null
        val spec = raw.trim().removePrefix("bytes=").substringBefore(',').trim()
        val dash = spec.indexOf('-')
        if (dash < 0) return null
        val left = spec.substring(0, dash).trim()
        val right = spec.substring(dash + 1).trim()
        return if (left.isEmpty()) {
            val suffix = right.toLongOrNull() ?: return null
            if (suffix <= 0L) return null
            val start = (total - suffix).coerceAtLeast(0L)
            start to (total - 1L)
        } else {
            val start = left.toLongOrNull() ?: return null
            val end = if (right.isEmpty()) {
                total - 1L
            } else {
                (right.toLongOrNull() ?: return null).coerceAtMost(total - 1L)
            }
            start to end
        }
    }

    private fun writeSimpleStatus(output: OutputStream, code: Int, text: String) {
        output.write("HTTP/1.1 $code $text\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
        output.flush()
    }

    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder(64)
        var prev = -1
        while (true) {
            val b = input.read()
            if (b == -1) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) {
                if (prev == '\r'.code && sb.isNotEmpty()) {
                    sb.setLength(sb.length - 1)
                }
                return sb.toString()
            }
            sb.append(b.toChar())
            prev = b
            if (sb.length > 8192) return sb.toString()
        }
    }
}
