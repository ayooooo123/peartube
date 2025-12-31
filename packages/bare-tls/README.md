# bare-tls

Transport Layer Security (TLS) streams for JavaScript.

```
npm i bare-tls
```

## Usage

On the server side:

```js
const tls = require('bare-tls')
const fs = require('bare-fs')

const socket = new tls.Socket(stream, {
  isServer: true,
  cert: fs.readFileSync('server-cert.pem'),
  key: fs.readFileSync('server-key.pem')
})

socket
  .on('connect', () => console.log('server connected'))
  .on('data', (data) => console.log(data))
  .write('Hello from server')
```

On the client side:

```js
const tls = require('bare-tls')

const socket = new tls.Socket(stream)

socket
  .on('connect', () => console.log('client connected'))
  .on('data', (data) => console.log(data))
  .write('Hello from client')
```

## License

Apache-2.0
