import test from 'brittle'
import { logger, setLogLevel, LogLevel } from '../src/logger.js'

// Helper to capture console output
function captureConsole(fn) {
  const logs = { log: [], warn: [], error: [], debug: [] }
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug
  }

  console.log = (...args) => logs.log.push(args.join(' '))
  console.warn = (...args) => logs.warn.push(args.join(' '))
  console.error = (...args) => logs.error.push(args.join(' '))
  console.debug = (...args) => logs.debug.push(args.join(' '))

  try {
    fn()
  } finally {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
    console.debug = original.debug
  }

  return logs
}

test('logger - creates logger with module name prefix', async (t) => {
  const log = logger('TestModule')
  const logs = captureConsole(() => {
    log.info('Hello world')
  })

  t.is(logs.log.length, 1)
  t.ok(logs.log[0].includes('[TestModule]'))
  t.ok(logs.log[0].includes('Hello world'))
})

test('logger - redacts mnemonic seed phrases', async (t) => {
  const log = logger('Test')
  // Pass a 12-word phrase directly (no prefix) - this matches the redaction pattern
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  const logs = captureConsole(() => {
    log.info(mnemonic)
  })

  t.ok(logs.log[0].includes('[MNEMONIC REDACTED]'))
  t.absent(logs.log[0].includes('abandon'))
})

test('logger - redacts sensitive keys in objects', async (t) => {
  const log = logger('Test')
  const logs = captureConsole(() => {
    log.info('User data', { username: 'alice', secretKey: 'supersecret123' })
  })

  t.ok(logs.log[0].includes('alice'))
  t.ok(logs.log[0].includes('[REDACTED]'))
  t.absent(logs.log[0].includes('supersecret123'))
})

test('logger - redacts privateKey', async (t) => {
  const log = logger('Test')
  const logs = captureConsole(() => {
    log.info('Keys', { publicKey: 'abc', privateKey: 'secret123' })
  })

  t.ok(logs.log[0].includes('[REDACTED]'))
  t.absent(logs.log[0].includes('secret123'))
})

test('logger - redacts password', async (t) => {
  const log = logger('Test')
  const logs = captureConsole(() => {
    log.info('Auth', { user: 'bob', password: 'hunter2' })
  })

  t.ok(logs.log[0].includes('[REDACTED]'))
  t.absent(logs.log[0].includes('hunter2'))
})

test('logger - redacts token', async (t) => {
  const log = logger('Test')
  const logs = captureConsole(() => {
    log.info('Session', { id: 123, token: 'jwt.secret.token' })
  })

  t.ok(logs.log[0].includes('[REDACTED]'))
  t.absent(logs.log[0].includes('jwt.secret.token'))
})

test('logger - redacts mnemonic key', async (t) => {
  const log = logger('Test')
  const logs = captureConsole(() => {
    log.info('Identity', { mnemonic: 'word1 word2 word3' })
  })

  t.ok(logs.log[0].includes('[REDACTED]'))
  t.absent(logs.log[0].includes('word1'))
})

test('logger - truncates long hex strings', async (t) => {
  const log = logger('Test')
  const longHex = 'a'.repeat(64)
  const logs = captureConsole(() => {
    log.info('Key:', longHex)
  })

  t.ok(logs.log[0].includes('aaaaaaaaaaaaaaaa...'))
  t.absent(logs.log[0].includes(longHex))
})

test('logger - truncates hex in object values', async (t) => {
  const log = logger('Test')
  const longHex = 'b'.repeat(64)
  const logs = captureConsole(() => {
    log.info('Data', { keyHex: longHex })
  })

  t.ok(logs.log[0].includes('bbbbbbbbbbbbbbbb...'))
})

test('logger - preserves short hex strings', async (t) => {
  const log = logger('Test')
  const shortHex = 'abcd1234'
  const logs = captureConsole(() => {
    log.info('Short:', shortHex)
  })

  t.ok(logs.log[0].includes(shortHex))
})

test('logger - handles nested objects', async (t) => {
  const log = logger('Test')
  const logs = captureConsole(() => {
    log.info('Nested', {
      user: {
        name: 'alice',
        auth: {
          password: 'secret123'
        }
      }
    })
  })

  t.ok(logs.log[0].includes('alice'))
  t.ok(logs.log[0].includes('[REDACTED]'))
  t.absent(logs.log[0].includes('secret123'))
})

test('logger - handles arrays', async (t) => {
  const log = logger('Test')
  const logs = captureConsole(() => {
    log.info('Items', [{ id: 1, token: 'abc' }, { id: 2, token: 'def' }])
  })

  t.ok(logs.log[0].includes('[REDACTED]'))
  t.absent(logs.log[0].includes('abc'))
  t.absent(logs.log[0].includes('def'))
})

test('logger - handles Buffer', async (t) => {
  const log = logger('Test')
  const logs = captureConsole(() => {
    log.info('Buffer', { data: Buffer.from('hello') })
  })

  t.ok(logs.log[0].includes('<Buffer'))
})

test('logger - handles large Buffer', async (t) => {
  const log = logger('Test')
  const logs = captureConsole(() => {
    log.info('Buffer', { data: Buffer.alloc(100) })
  })

  t.ok(logs.log[0].includes('100 bytes'))
  t.ok(logs.log[0].includes('...'))
})

test('logger - handles Error objects', async (t) => {
  const log = logger('Test')
  const logs = captureConsole(() => {
    log.error('Failed', new Error('Something went wrong'))
  })

  t.ok(logs.error[0].includes('Something went wrong'))
})

test('logger - handles null and undefined', async (t) => {
  const log = logger('Test')
  const logs = captureConsole(() => {
    log.info('Values', { a: null, b: undefined })
  })

  t.ok(logs.log[0].includes('null'))
})

test('logger - child logger has parent prefix', async (t) => {
  const log = logger('Parent')
  const child = log.child('Child')
  const logs = captureConsole(() => {
    child.info('Hello')
  })

  t.ok(logs.log[0].includes('[Parent:Child]'))
})

test('logger - respects log levels', async (t) => {
  setLogLevel('WARN')

  const log = logger('Test')
  const logs = captureConsole(() => {
    log.debug('Debug message')
    log.info('Info message')
    log.warn('Warn message')
    log.error('Error message')
  })

  // Only WARN and ERROR should be logged
  t.is(logs.debug.length, 0)
  t.is(logs.log.length, 0)
  t.is(logs.warn.length, 1)
  t.is(logs.error.length, 1)

  // Reset to INFO for other tests
  setLogLevel('INFO')
})

test('logger - DEBUG level shows all messages', async (t) => {
  setLogLevel('DEBUG')

  const log = logger('Test')
  const logs = captureConsole(() => {
    log.debug('Debug')
    log.info('Info')
    log.warn('Warn')
    log.error('Error')
  })

  t.is(logs.debug.length, 1)
  t.is(logs.log.length, 1)
  t.is(logs.warn.length, 1)
  t.is(logs.error.length, 1)

  setLogLevel('INFO')
})

test('logger - SILENT level shows nothing', async (t) => {
  setLogLevel('SILENT')

  const log = logger('Test')
  const logs = captureConsole(() => {
    log.debug('Debug')
    log.info('Info')
    log.warn('Warn')
    log.error('Error')
  })

  t.is(logs.debug.length, 0)
  t.is(logs.log.length, 0)
  t.is(logs.warn.length, 0)
  t.is(logs.error.length, 0)

  setLogLevel('INFO')
})

test('LogLevel - exports level constants', async (t) => {
  t.is(LogLevel.DEBUG, 0)
  t.is(LogLevel.INFO, 1)
  t.is(LogLevel.WARN, 2)
  t.is(LogLevel.ERROR, 3)
  t.is(LogLevel.SILENT, 4)
})

test('logger - handles unserializable objects gracefully', async (t) => {
  const log = logger('Test')
  // Create an object that throws during JSON.stringify
  const unserializable = {
    toJSON() {
      throw new Error('Cannot serialize')
    }
  }

  const logs = captureConsole(() => {
    log.info('Bad object', unserializable)
  })

  t.ok(logs.log[0].includes('[unserializable]'))
})

test('logger - handles deeply nested objects with max depth', async (t) => {
  const log = logger('Test')
  // Create deeply nested circular structure - redact() handles with depth limit
  const circular = {}
  circular.self = circular

  const logs = captureConsole(() => {
    log.info('Deep', circular)
  })

  // Due to depth limiting, circular refs become [max depth] and are serializable
  t.ok(logs.log[0].includes('[max depth]'))
})

test('logger - redacts keys with underscores and dashes', async (t) => {
  const log = logger('Test')
  const logs = captureConsole(() => {
    log.info('Keys', {
      secret_key: 'abc',
      'private-key': 'def',
      access_token: 'ghi'
    })
  })

  t.is(logs.log[0].match(/\[REDACTED\]/g).length, 3)
})

test('logger - prevents infinite recursion on deeply nested objects', async (t) => {
  const log = logger('Test')

  // Create deeply nested object
  let obj = { value: 'leaf' }
  for (let i = 0; i < 20; i++) {
    obj = { nested: obj }
  }

  const logs = captureConsole(() => {
    log.info('Deep', obj)
  })

  // Should not throw, and should contain max depth marker
  t.ok(logs.log[0].includes('[max depth]'))
})
