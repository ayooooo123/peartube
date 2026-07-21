import https from 'bare-https'

export const request = https.request.bind(https)
