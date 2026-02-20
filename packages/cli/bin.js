#!/usr/bin/env node

import { command, flag, arg } from 'paparam'
import goodbye from 'graceful-goodbye'

const cmd = command('peartube-peer',
  flag('--storage|-s [path]', 'Storage path').default('./peartube-peer'),
  flag('--max-storage|-m [mb]', 'Max storage in MB').default(100000),
  flag('--channel|-c [key]', 'Pin a channel key (can be repeated)').multiple(),
  flag('--debug|-d', 'Enable debug logging'),
  async function ({ flags }) {
    const { startPeer } = await import('./src/index.js')

    const storagePath = flags.storage
    const maxStorageMB = Number(flags['max-storage'])
    const pinnedChannels = flags.channel || []
    const debug = !!flags.debug

    const peer = await startPeer({ storagePath, maxStorageMB, pinnedChannels, debug })

    goodbye(async () => {
      await peer.close()
    })
  }
)

cmd.parse()
