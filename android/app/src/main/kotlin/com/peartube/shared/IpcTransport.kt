package com.peartube.shared

import kotlinx.coroutines.CompletableDeferred
import to.holepunch.bare.kit.BareKitException
import to.holepunch.bare.kit.Ipc
import to.holepunch.bare.kit.Worklet
import java.io.ByteArrayOutputStream

/** The JS engine: `worklet/worker.js` in a Bare worklet, spoken to over `Bare.IPC`. */
class IpcTransport(
    private val ready: CompletableDeferred<Ipc?>,
    private val worklet: () -> Worklet?,
) : EngineTransport {
    override suspend fun send(line: ByteArray) {
        val ipc = ready.await() ?: throw EngineClosedException()
        try {
            ipc.write(line)
        } catch (e: BareKitException.Closed) {
            throw EngineClosedException(e)
        }
    }

    override suspend fun read(onLine: (String) -> Unit) {
        val ipc = ready.await() ?: throw EngineClosedException()
        val incoming = ByteArrayOutputStream()
        ipc.data.collect { bytes ->
            var start = 0
            for (i in bytes.indices) {
                if (bytes[i] == '\n'.code.toByte()) {
                    incoming.write(bytes, start, i - start)
                    onLine(incoming.toString(Charsets.UTF_8.name()))
                    incoming.reset()
                    start = i + 1
                }
            }
            incoming.write(bytes, start, bytes.size - start)
        }
    }

    override fun suspend() {
        worklet()?.suspend()
    }

    override fun resume() {
        worklet()?.resume()
    }
}
