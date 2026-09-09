export const NAMESPACE_ROLES = Object.freeze([
  'source',
  'safety-guard',
  'safety-final',
  'private-entry',
  'private-middle',
  'private-final',
  'destination',
  'decoy',
  'auditor'
])

const SHORT_ROLE = Object.freeze({
  source: 's',
  'safety-guard': 'sg',
  'safety-final': 'sf',
  'private-entry': 'pe',
  'private-middle': 'pm',
  'private-final': 'pf',
  destination: 'd',
  decoy: 'x',
  auditor: 'a'
})

function invalid() {
  throw new TypeError('invalid namespace configuration')
}

function validSuffix(value) {
  return typeof value === 'string' && /^[a-z0-9]{1,6}$/.test(value)
}

function freezeMember(value) {
  return Object.freeze({ ...value })
}

export function createNamespaceLayout(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid()
  const { suffix, subnetId, portBase } = options
  if (
    !validSuffix(suffix) ||
    !Number.isSafeInteger(subnetId) ||
    subnetId < 1 ||
    subnetId > 250 ||
    !Number.isSafeInteger(portBase) ||
    portBase < 1_024 ||
    portBase + 101 > 65_535
  ) {
    invalid()
  }
  const subnet = `10.203.${subnetId}`
  const members = NAMESPACE_ROLES.map((role, index) =>
    freezeMember({
      role,
      namespace: `pr${SHORT_ROLE[role]}${suffix}`,
      hostVeth: `ph${index}${suffix}`,
      peerVeth: `pn${index}${suffix}`,
      address: `${subnet}.${index + 2}`,
      prefix: 24,
      port:
        role === 'decoy' ? portBase + 100 : role === 'auditor' ? portBase + 101 : portBase + index,
      route: role !== 'decoy' && role !== 'auditor'
    })
  )
  return Object.freeze({
    roles: NAMESPACE_ROLES,
    subnet,
    portBase,
    bridge: Object.freeze({ name: `pb${suffix}`, address: `${subnet}.1`, prefix: 24 }),
    members: Object.freeze(members)
  })
}

function layoutMember(layout, role) {
  if (!layout || !Array.isArray(layout.members)) invalid()
  const member = layout.members.find((value) => value.role === role)
  if (!member) invalid()
  return member
}

export function createCaptureMatrix(layout, contacts, phases, interfaceIndexes, sentinels = null) {
  if (
    !contacts ||
    typeof contacts !== 'object' ||
    !phases ||
    typeof phases !== 'object' ||
    !interfaceIndexes ||
    typeof interfaceIndexes !== 'object' ||
    Array.isArray(interfaceIndexes)
  ) {
    invalid()
  }
  const roles = {}
  const seenInterfaceIndexes = new Set()
  for (const member of layout.members) {
    const interfaceIndex = interfaceIndexes[member.role]
    if (
      !Number.isSafeInteger(interfaceIndex) ||
      interfaceIndex < 1 ||
      seenInterfaceIndexes.has(interfaceIndex)
    ) {
      invalid()
    }
    seenInterfaceIndexes.add(interfaceIndex)
    roles[member.role] = Object.freeze({
      addresses: Object.freeze([member.address]),
      port: member.port,
      route: member.route,
      interfaceIndex
    })
  }
  const copiedContacts = {}
  const requiredEdges = []
  for (const { role, route } of layout.members) {
    if (!route) continue
    if (!Array.isArray(contacts[role])) invalid()
    copiedContacts[role] = Object.freeze([...contacts[role]])
    for (const peer of contacts[role]) requiredEdges.push(Object.freeze([role, peer]))
  }
  return Object.freeze({
    roles: Object.freeze(roles),
    contacts: Object.freeze(copiedContacts),
    portRange: Object.freeze({ min: layout.portBase, max: layout.portBase + 6 }),
    requiredEdges: Object.freeze(requiredEdges),
    phases: Object.freeze({ ...phases }),
    ...(sentinels ? { sentinels } : {})
  })
}

export function namespaceExecLaunch(layout, role, executable, args = []) {
  const member = layoutMember(layout, role)
  if (typeof executable !== 'string' || executable.length === 0 || !Array.isArray(args)) invalid()
  for (const value of args) if (typeof value !== 'string') invalid()
  return Object.freeze({
    command: 'ip',
    args: Object.freeze(['netns', 'exec', member.namespace, executable, ...args])
  })
}

export function namespaceLaunch(layout, role, executable, args = []) {
  const member = layoutMember(layout, role)
  if (!member.route) throw new TypeError('namespace launch requires a route role')
  return namespaceExecLaunch(layout, role, executable, args)
}

function inside(namespace, command, ...args) {
  return ['netns', 'exec', namespace, command, ...args]
}

export function createNamespaceManager(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid()
  const { layout, execute } = options
  if (!layout || !Array.isArray(layout.members) || typeof execute !== 'function') invalid()
  const cleanupActions = []
  let state = 'new'

  const run = (command, args) => execute(command, [...args])

  const cleanup = async () => {
    if (state === 'closed') return []
    state = 'closed'
    const results = []
    while (cleanupActions.length > 0) {
      const action = cleanupActions.pop()
      try {
        await run(action.command, action.args)
        results.push(Object.freeze({ status: 'fulfilled' }))
      } catch (reason) {
        results.push(Object.freeze({ status: 'rejected', reason }))
      }
    }
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        'namespace cleanup failed'
      )
    }
    return results
  }

  const readInterfaceIndexes = async () => {
    const result = {}
    const seen = new Set()
    for (const member of layout.members) {
      const output = await run('ip', ['-j', 'link', 'show', 'dev', member.hostVeth])
      let records
      try {
        records = JSON.parse(output?.stdout)
      } catch {
        invalid()
      }
      const record = records?.[0]
      if (
        !Array.isArray(records) ||
        records.length !== 1 ||
        record.ifname !== member.hostVeth ||
        !Number.isSafeInteger(record.ifindex) ||
        record.ifindex < 1 ||
        seen.has(record.ifindex)
      ) {
        invalid()
      }
      seen.add(record.ifindex)
      result[member.role] = record.ifindex
    }
    return Object.freeze(result)
  }

  const setupMember = async (member) => {
    await run('ip', ['netns', 'add', member.namespace])
    cleanupActions.push({ command: 'ip', args: ['netns', 'delete', member.namespace] })
    await run('ip', [
      'link',
      'add',
      member.hostVeth,
      'type',
      'veth',
      'peer',
      'name',
      member.peerVeth
    ])
    cleanupActions.push({ command: 'ip', args: ['link', 'delete', member.hostVeth] })
    await run('ip', ['link', 'set', member.hostVeth, 'master', layout.bridge.name])
    await run('ip', ['link', 'set', member.hostVeth, 'up'])
    await run('ip', ['link', 'set', member.peerVeth, 'netns', member.namespace])
    await run('ip', inside(member.namespace, 'ip', 'link', 'set', 'lo', 'up'))
    await run('ip', inside(member.namespace, 'ip', 'link', 'set', member.peerVeth, 'name', 'eth0'))
    await run(
      'ip',
      inside(member.namespace, 'ip', 'link', 'set', 'dev', 'eth0', 'addrgenmode', 'none')
    )
    for (const setting of [
      'net.ipv6.conf.all.autoconf=0',
      'net.ipv6.conf.default.autoconf=0',
      'net.ipv6.conf.eth0.autoconf=0',
      'net.ipv6.conf.all.accept_ra=0',
      'net.ipv6.conf.default.accept_ra=0',
      'net.ipv6.conf.eth0.accept_ra=0'
    ]) {
      await run('ip', inside(member.namespace, 'sysctl', '-q', '-w', setting))
    }
    await run(
      'ip',
      inside(
        member.namespace,
        'ip',
        'address',
        'add',
        `${member.address}/${member.prefix}`,
        'dev',
        'eth0'
      )
    )
    await run('ip', inside(member.namespace, 'ip', 'link', 'set', 'eth0', 'up'))
    await run(
      'ip',
      inside(
        member.namespace,
        'iptables',
        '-I',
        'OUTPUT',
        '-p',
        'icmp',
        '--icmp-type',
        'port-unreachable',
        '-j',
        'DROP'
      )
    )
  }

  const setup = async () => {
    if (state !== 'new') invalid()
    state = 'opening'
    try {
      await run('ip', ['link', 'add', 'name', layout.bridge.name, 'type', 'bridge'])
      cleanupActions.push({ command: 'ip', args: ['link', 'delete', layout.bridge.name] })
      await run('ip', [
        'address',
        'add',
        `${layout.bridge.address}/${layout.bridge.prefix}`,
        'dev',
        layout.bridge.name
      ])
      await run('ip', ['link', 'set', layout.bridge.name, 'up'])
      for (const member of layout.members) await setupMember(member)
      const interfaceIndexes = await readInterfaceIndexes()
      state = 'open'
      return interfaceIndexes
    } catch (error) {
      await cleanup()
      throw error
    }
  }

  return Object.freeze({ setup, cleanup })
}
