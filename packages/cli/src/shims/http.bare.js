import http from 'bare-http1'

export const createServer = http.createServer.bind(http)
export const request = http.request.bind(http)
