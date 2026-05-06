import http from 'bare-http1'

export const createServer = http.createServer.bind(http)
