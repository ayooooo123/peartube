/**
 * Upgrade-drive replication for a swarm PearTube already owns.
 *
 * `pear-mobile` only wires replication and the topic join for a swarm it
 * created itself, so a shared swarm has to be told about the upgrade drive by
 * hand. This module is that wiring, and it is deliberately narrow: it attaches
 * the drive's own cores and nothing else.
 *
 * A blanket `store.replicate(connection)` would answer any peer's
 * discovery-key probe for every core on disk, outside the scoped network
 * runtime's authorization and upload controls. That is the exact failure this
 * module exists to make impossible, which is why it never sees a Corestore.
 */
import Protomux from 'protomux'

/**
 * @param {object} options
 * @param {object} options.swarm Hyperswarm instance PearTube owns.
 * @param {object} options.drive Hyperdrive held by the Pear updater.
 * @param {(error: unknown, stage: 'replicate' | 'join' | 'detach') => void} [options.onError]
 * @returns {{ detach: () => void, discovery: object | null }}
 */
export function attachUpdateDriveReplication({ swarm, drive, onError = () => {} } = {}) {
  const replicated = new Set()

  const replicateOn = (core, connection) => {
    try {
      core.replicate(Protomux.from(connection))
    } catch (error) {
      onError(error, 'replicate')
    }
  }

  const attachCore = (core) => {
    if (!core || replicated.has(core)) return
    replicated.add(core)
    for (const connection of swarm.connections || []) replicateOn(core, connection)
  }

  let onConnection = (connection) => {
    for (const core of replicated) replicateOn(core, connection)
  }
  swarm.on('connection', onConnection)

  attachCore(drive.core)
  // The blobs core only exists once the drive's header has synced, and the
  // mirror needs it to pull file contents.
  const onBlobs = (blobs) => attachCore(blobs?.core)
  drive.on('blobs', onBlobs)
  attachCore(drive.blobs?.core)

  let discovery = null
  try {
    discovery = swarm.join(drive.core.discoveryKey, { client: true, server: false })
  } catch (error) {
    onError(error, 'join')
  }

  const detach = () => {
    if (!onConnection) return
    try {
      swarm.removeListener('connection', onConnection)
      drive.removeListener?.('blobs', onBlobs)
    } catch (error) {
      onError(error, 'detach')
    }
    onConnection = null
    replicated.clear()
  }

  return { detach, discovery }
}
