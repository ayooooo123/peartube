import b4a from 'b4a'

import {
  AUTHORIZATION_MODE,
  CAPABILITY,
  CELL_SIZE,
  LINK_OPERATION,
  PROTOCOL_VERSION,
  ROLE,
  TOPOLOGY_ROLE,
  activationChallengeCipher,
  buildPrivateTemplates,
  cryptoSuite,
  encodeActivationRequest,
  encodeCreate,
  encodeDescriptor,
  encodeRelayAdvertisement,
  hashCreateBase,
  signDescriptor,
  signRelayAdvertisement,
  signTopologyGrant
} from '../index.js'
import { privateRoleIdentity, safetyRoleIdentity, seed } from './helpers.js'

export const LIVE_ROUTE_ROLES = Object.freeze([
  'source',
  'safety-guard',
  'safety-final',
  'private-entry',
  'private-middle',
  'private-final',
  'destination'
])

export const LIVE_ROUTE_KNOWLEDGE = Object.freeze({
  source: Object.freeze(['source', 'safety-guard', 'safety-final', 'private-entry']),
  'safety-guard': Object.freeze(['source', 'safety-guard', 'safety-final']),
  'safety-final': Object.freeze(['safety-guard', 'safety-final', 'private-entry']),
  'private-entry': Object.freeze(['safety-final', 'private-entry', 'private-middle']),
  'private-middle': Object.freeze(['private-entry', 'private-middle', 'private-final']),
  'private-final': Object.freeze(['private-middle', 'private-final', 'destination']),
  destination: Object.freeze(['private-entry', 'private-middle', 'private-final', 'destination'])
})

export const LIVE_ROUTE_CONTACTS = Object.freeze({
  source: Object.freeze(['safety-guard']),
  'safety-guard': Object.freeze(['source', 'safety-final']),
  'safety-final': Object.freeze(['safety-guard', 'private-entry']),
  'private-entry': Object.freeze(['safety-final', 'private-middle']),
  'private-middle': Object.freeze(['private-entry', 'private-final']),
  'private-final': Object.freeze(['private-middle', 'destination']),
  destination: Object.freeze(['private-final'])
})

const TOPOLOGY_ROLES = Object.freeze([
  TOPOLOGY_ROLE.SOURCE,
  TOPOLOGY_ROLE.SAFETY_GUARD,
  TOPOLOGY_ROLE.SAFETY_FINAL,
  TOPOLOGY_ROLE.PRIVATE_ENTRY,
  TOPOLOGY_ROLE.PRIVATE_MIDDLE,
  TOPOLOGY_ROLE.PRIVATE_FINAL,
  TOPOLOGY_ROLE.DESTINATION
])

function sequence(start) {
  let value = start
  return (size) => b4a.alloc(size, value++)
}

function relayAdvertisement(record, role, epoch, expiresAt) {
  return signRelayAdvertisement(
    {
      version: PROTOCOL_VERSION,
      identityKey: record.identity.publicKey,
      routeEncryptionKey: record.encryption.publicKey,
      dial: b4a.from(`live-route-${record.role}`),
      role,
      capabilities: CAPABILITY.KNOWN,
      epoch,
      expiresAt
    },
    record.identity.secretKey
  )
}

function copyIdentity(record) {
  return Object.freeze({ role: record.role, identity32: b4a.from(record.identity.publicKey) })
}

function copyLocal(record) {
  return Object.freeze({
    identity32: b4a.from(record.identity.publicKey),
    identitySecretKey: b4a.from(record.identity.secretKey),
    ...(record.encryption
      ? {
          routeEncryptionKey: b4a.from(record.encryption.publicKey),
          routeEncryptionSecretKey: b4a.from(record.encryption.secretKey)
        }
      : {})
  })
}

function actorId(index) {
  const id = b4a.alloc(16)
  id[0] = 0xa0
  id[15] = index + 1
  return id
}

export function createLiveRouteFixture(options = {}) {
  const epoch = options.epoch === undefined ? 23n : options.epoch
  const now = options.now === undefined ? 1_000n : options.now
  const expiresAt = options.expiresAt === undefined ? 30_000n : options.expiresAt
  const portBase = options.portBase === undefined ? 48_100 : options.portBase
  const distinctHosts = options.distinctHosts === undefined ? true : options.distinctHosts
  const topologyAuthority = cryptoSuite.keyPair(seed(20))
  const runId32 = seed(21)
  const routeCircuitDigest = cryptoSuite.hash([
    b4a.from('live-route-circuit-v0'),
    b4a.from(`${epoch}:${portBase}`)
  ])
  const routeCircuitId = b4a.from(routeCircuitDigest.subarray(0, 16))
  routeCircuitDigest.fill(0)
  if (routeCircuitId.every((value) => value === 0)) routeCircuitId[15] = 1
  const routePayloadKeys = cryptoSuite.deriveKeys(
    seed(26),
    b4a.from(`live-route-payload-v0:${epoch}:${portBase}`)
  )
  const destinationIdentity = cryptoSuite.keyPair(seed(22))
  const records = LIVE_ROUTE_ROLES.map((role, index) => {
    let identity
    let encryption = null
    if (index === 1 || index === 2) {
      identity = safetyRoleIdentity(30 + index * 10)
      encryption = cryptoSuite.encryptionKeyPair(seed(80 + index))
    } else if (index >= 3 && index <= 5) {
      identity = privateRoleIdentity(10 + (index - 3) * 20)
      encryption = cryptoSuite.encryptionKeyPair(seed(90 + index))
    } else {
      identity = index === 0 ? cryptoSuite.keyPair(seed(23)) : destinationIdentity
    }
    return {
      role,
      topologyRole: TOPOLOGY_ROLES[index],
      host: distinctHosts ? `127.0.0.${51 + index}` : '127.0.0.1',
      port: portBase + index,
      identity,
      encryption,
      actorId: index >= 3 ? actorId(index) : null,
      advertisement: null
    }
  })
  for (let index = 1; index <= 5; index++) {
    records[index].advertisement = relayAdvertisement(
      records[index],
      index <= 2 ? ROLE.SAFETY : ROLE.PRIVATE,
      epoch,
      expiresAt
    )
  }
  const descriptorId = seed(24)
  const finalToken = b4a.alloc(64, 0xfe)
  const destinationEncryption = cryptoSuite.encryptionKeyPair(seed(25))
  records[6].encryption = destinationEncryption
  const privateAdvertisements = records
    .slice(3, 6)
    .map((record) => encodeRelayAdvertisement(record.advertisement))
  const built = buildPrivateTemplates({
    descriptorId,
    epoch,
    expiresAt,
    endpointKey: destinationIdentity.publicKey,
    routeSigningKey: destinationIdentity.publicKey,
    authorizationMode: AUTHORIZATION_MODE.DIRECT,
    destinationSecretKey: destinationIdentity.secretKey,
    relays: privateAdvertisements,
    randomBytes: sequence(100),
    finalToken,
    now
  })
  const descriptor = encodeDescriptor(
    signDescriptor(
      {
        version: PROTOCOL_VERSION,
        authorizationMode: AUTHORIZATION_MODE.DIRECT,
        descriptorId,
        endpointKey: destinationIdentity.publicKey,
        routeSigningKey: destinationIdentity.publicKey,
        routeEncryptionKey: destinationEncryption.publicKey,
        entryAdvertisement: privateAdvertisements[0],
        epoch,
        expiresAt,
        capabilities: CAPABILITY.KNOWN,
        cellSize: CELL_SIZE,
        encryptedHops: built.encryptedHops
      },
      destinationIdentity.secretKey
    )
  )
  const sourceEphemeral = cryptoSuite.encryptionKeyPair(seed(27))
  const entryChallenge = seed(28)
  const destinationChallenge = seed(29)
  const createValue = {
    version: PROTOCOL_VERSION,
    circuitId: routeCircuitId,
    epoch,
    descriptorId,
    sourceEphemeralKey: sourceEphemeral.publicKey,
    safetyTranscriptHash: seed(30),
    entryChallengeCipher: b4a.alloc(48),
    destinationChallengeCipher: b4a.alloc(48),
    encryptedHops: built.encryptedHops
  }
  const createBaseHash = hashCreateBase(createValue)
  const entryShared = cryptoSuite.keyAgreement(
    sourceEphemeral.secretKey,
    records[3].encryption.publicKey
  )
  const destinationShared = cryptoSuite.keyAgreement(
    sourceEphemeral.secretKey,
    destinationEncryption.publicKey
  )
  createValue.entryChallengeCipher = activationChallengeCipher(
    entryShared,
    createBaseHash,
    entryChallenge,
    0
  )
  createValue.destinationChallengeCipher = activationChallengeCipher(
    destinationShared,
    createBaseHash,
    destinationChallenge,
    1
  )
  const create = encodeCreate(createValue)
  const activationBody = encodeActivationRequest({
    entry: true,
    create,
    layer: b4a.alloc(0),
    expiresAt,
    startedAt: Number(now),
    parameters: {
      version: PROTOCOL_VERSION,
      cellSize: 1_200,
      routeFrameSize: 1_100,
      maxCellPayload: 1_146,
      maxRoutePayload: 1_073,
      capabilities: 7,
      safetyMin: 1,
      safetyMax: 3,
      privateMin: 1,
      privateMax: 3,
      counterWindow: 64
    },
    entryProof: b4a.alloc(0)
  })
  const grants = []
  for (let index = 0; index < records.length - 1; index++) {
    const left = records[index]
    const right = records[index + 1]
    grants.push(
      signTopologyGrant(
        {
          version: PROTOCOL_VERSION,
          format: 0,
          grantId32: seed(120 + index),
          endpointA: {
            identity32: left.identity.publicKey,
            role: left.topologyRole,
            host: left.host,
            port: left.port,
            operations: LINK_OPERATION.INITIATE
          },
          endpointB: {
            identity32: right.identity.publicKey,
            role: right.topologyRole,
            host: right.host,
            port: right.port,
            operations: LINK_OPERATION.ACCEPT
          },
          epoch,
          notBefore: now - 1n,
          expiresAt,
          runId32
        },
        topologyAuthority.secretKey
      )
    )
  }
  const projections = new Map()
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    const contactNames = LIVE_ROUTE_CONTACTS[record.role]
    const contactIndexes = contactNames.map((name) => LIVE_ROUTE_ROLES.indexOf(name))
    const grantIndexes = []
    if (index > 0) grantIndexes.push(index - 1)
    if (index < records.length - 1) grantIndexes.push(index)
    const route =
      record.role === 'source'
        ? Object.freeze({
            safetyAdvertisements: records
              .slice(1, 3)
              .map((value) => encodeRelayAdvertisement(value.advertisement)),
            entryActorId: b4a.from(records[3].actorId),
            descriptor: b4a.from(descriptor),
            registrationCapsule: b4a.from(built.registrationCapsule),
            prepareCapsule: b4a.from(built.prepareCapsule),
            finalizeCapsule: b4a.from(built.finalizeCapsule),
            abortCapsule: b4a.from(built.abortCapsule),
            registrations: built.registrations.map((value) =>
              Object.freeze({ message: b4a.from(value.message) })
            ),
            activation: Object.freeze({
              body: b4a.from(activationBody),
              circuitId: b4a.from(routeCircuitId),
              generation: 1n,
              entryIdentity: b4a.from(records[3].identity.publicKey),
              entryRouteEncryptionKey: b4a.from(records[3].encryption.publicKey),
              endpointIdentity: b4a.from(destinationIdentity.publicKey),
              routeSigningKey: b4a.from(destinationIdentity.publicKey),
              destinationRouteEncryptionKey: b4a.from(destinationEncryption.publicKey),
              sourceEphemeralSecretKey: b4a.from(sourceEphemeral.secretKey),
              entryChallenge: b4a.from(entryChallenge),
              destinationChallenge: b4a.from(destinationChallenge)
            }),
            payload: Object.freeze({
              descriptorId: b4a.from(descriptorId),
              circuitId: b4a.from(routeCircuitId),
              forwardKey: b4a.from(routePayloadKeys.forwardKey),
              forwardNoncePrefix: b4a.from(routePayloadKeys.forwardNoncePrefix),
              reverseKey: b4a.from(routePayloadKeys.reverseKey),
              reverseNoncePrefix: b4a.from(routePayloadKeys.reverseNoncePrefix)
            })
          })
        : record.role.startsWith('private-')
          ? Object.freeze({
              actorId: b4a.from(record.actorId),
              advertisement: encodeRelayAdvertisement(record.advertisement),
              registration: Object.freeze({
                message: b4a.from(built.registrations[index - 3].message),
                sealedTemplate: b4a.from(built.registrations[index - 3].sealedTemplate)
              })
            })
          : record.role === 'destination'
            ? Object.freeze({
                actorId: b4a.from(record.actorId),
                descriptorId: b4a.from(descriptorId),
                routeSigningKey: b4a.from(destinationIdentity.publicKey),
                routeSigningSecretKey: b4a.from(destinationIdentity.secretKey),
                routeEncryptionKey: b4a.from(destinationEncryption.publicKey),
                routeEncryptionSecretKey: b4a.from(destinationEncryption.secretKey),
                finalToken: b4a.from(finalToken),
                privateAdvertisements: privateAdvertisements.map((value) => b4a.from(value)),
                payload: Object.freeze({
                  descriptorId: b4a.from(descriptorId),
                  circuitId: b4a.from(routeCircuitId),
                  forwardKey: b4a.from(routePayloadKeys.forwardKey),
                  forwardNoncePrefix: b4a.from(routePayloadKeys.forwardNoncePrefix),
                  reverseKey: b4a.from(routePayloadKeys.reverseKey),
                  reverseNoncePrefix: b4a.from(routePayloadKeys.reverseNoncePrefix)
                })
              })
            : Object.freeze({
                advertisement: encodeRelayAdvertisement(record.advertisement)
              })
    projections.set(
      record.role,
      Object.freeze({
        version: PROTOCOL_VERSION,
        role: record.role,
        topologyRole: record.topologyRole,
        bind: Object.freeze({ host: record.host, port: record.port }),
        local: copyLocal(record),
        linkAuthorityPublicKey: b4a.from(topologyAuthority.publicKey),
        epoch,
        runId32: b4a.from(runId32),
        linkCircuitId: b4a.from(routeCircuitId),
        known: LIVE_ROUTE_KNOWLEDGE[record.role].map((name) =>
          copyIdentity(records[LIVE_ROUTE_ROLES.indexOf(name)])
        ),
        contacts: contactIndexes.map((peerIndex) =>
          Object.freeze({
            role: records[peerIndex].role,
            identity32: b4a.from(records[peerIndex].identity.publicKey),
            routeEncryptionKey: records[peerIndex].encryption
              ? b4a.from(records[peerIndex].encryption.publicKey)
              : null,
            actorId: records[peerIndex].actorId ? b4a.from(records[peerIndex].actorId) : null
          })
        ),
        grants: grantIndexes.map((grantIndex) => b4a.from(grants[grantIndex])),
        route
      })
    )
  }
  const fixture = Object.freeze({
    roles: LIVE_ROUTE_ROLES,
    knowledge: LIVE_ROUTE_KNOWLEDGE,
    contacts: LIVE_ROUTE_CONTACTS,
    projections,
    epoch,
    runId32: b4a.from(runId32)
  })
  routeCircuitId.fill(0)
  routePayloadKeys.forwardKey.fill(0)
  routePayloadKeys.forwardNoncePrefix.fill(0)
  routePayloadKeys.reverseKey.fill(0)
  routePayloadKeys.reverseNoncePrefix.fill(0)
  sourceEphemeral.secretKey.fill(0)
  entryChallenge.fill(0)
  destinationChallenge.fill(0)
  createBaseHash.fill(0)
  entryShared.fill(0)
  destinationShared.fill(0)
  create.fill(0)
  activationBody.fill(0)
  createValue.entryChallengeCipher.fill(0)
  createValue.destinationChallengeCipher.fill(0)
  return fixture
}
