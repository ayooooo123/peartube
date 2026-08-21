import http from 'bare-http1'
import net from 'bare-net'

export const createServer = http.createServer.bind(http)
export const request = http.request.bind(http)
export const connectUnix = net.createConnection.bind(net)

export function createUnixServer (onrequest) {
  const protocol = http.createServer(onrequest)
  const server = net.createServer((socket) => protocol.emit('connection', socket))
  server.setTimeout = (ms, ontimeout) => {
    protocol.setTimeout(ms, ontimeout)
    return server
  }
  return server
}
