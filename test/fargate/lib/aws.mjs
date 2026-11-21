// AWS lifecycle for the Fargate swarm test.
//
// Everything this test creates in AWS is named `peartube-fargate-swarm-<run>` and
// tagged `peartube-fargate-swarm=<run>`. `up` reuses a resource only after it reads
// that exact tag back. `down` deletes only resources that carry it. A resource with
// the right name and the wrong tag is never reused and never deleted.
//
// `opts.dryRun` prints every aws, git and docker command and every rendered task
// definition, and returns placeholders instead of ids. It calls no AWS, git or
// docker command and writes no state.

import { execFile, spawn } from 'node:child_process'
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, open, unlink, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const TAG_KEY = 'peartube-fargate-swarm'
const NAME_PREFIX = `${TAG_KEY}-`
const TASK_DIR = fileURLToPath(new URL('../taskdefs/', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const BLIND_PEER_IMAGE = 'docker.io/tetherto/blind-peer:v1.15.1-r7'
const EXECUTION_POLICY = 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'
const EGRESS_PERMISSIONS = '[{"IpProtocol":"-1","IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]'
const TRUST_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 'ecs-tasks.amazonaws.com' },
      Action: 'sts:AssumeRole',
    },
  ],
}

// z-base-32, the alphabet hypercore ids use in logs.
const Z32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769'
const Z32_INDEX = new Map([...Z32_ALPHABET].map((character, index) => [character, index]))

// PKCS#8 prefix for an Ed25519 private key followed by the 32-byte seed.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

const TASK_KEYS = [
  'peartube',
  'peartube-relayed',
  'blind-peer',
  'blind-relay',
  'relayed-peer',
]

// 0.25 vCPU everywhere: the account's Fargate On-Demand quota is 4 vCPU (an increase is requested),
// and 20 tasks at 0.25 vCPU need 5. The home uplink, not CPU, bounds what a task can replicate.
const DEFAULT_SIZES = {
  peartube: { cpu: '256', memory: '1024' },
  blindPeer: { cpu: '256', memory: '1024' },
  blindRelay: { cpu: '256', memory: '512' },
  relayedPeer: { cpu: '256', memory: '1024' },
}


// Decode a 52-character z32 hypercore id to 64 hex characters. A 64-hex id is
// returned unchanged so callers can pass either shape.
export function decodeZ32 (id) {
  const text = String(id ?? '').trim().toLowerCase()
  if (/^[0-9a-f]{64}$/.test(text)) return text
  if (text.length !== 52) {
    throw new Error('a z32 public key is 52 characters')
  }

  const bytes = []
  let accumulator = 0
  let bits = 0
  for (const character of text) {
    const value = Z32_INDEX.get(character)
    if (value === undefined) {
      throw new Error(`invalid z32 character ${character}`)
    }
    accumulator = (accumulator << 5) | value
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((accumulator >> bits) & 0xff)
    }
    accumulator &= (1 << bits) - 1
  }

  if (bytes.length !== 32) {
    throw new Error('a z32 public key holds 32 bytes')
  }
  return Buffer.from(bytes).toString('hex')
}

// Run the aws CLI and return its parsed JSON. Every command gets `--output json`.
// Errors and printed command lines are scrubbed of account ids, email addresses,
// access key ids, known run secrets and the operator's home directory.
export async function aws (args, options = {}) {
  if (!Array.isArray(args) || args.length < 2) {
    throw new TypeError('aws(args) needs a service and an operation')
  }

  const service = args[0]
  const operation = args[1]
  const secrets = Array.isArray(options.secrets) ? options.secrets : []
  const argv = [...args]
  if (options.region && !argv.includes('--region')) {
    argv.push('--region', options.region)
  }
  if (!argv.includes('--output')) {
    argv.push('--output', 'json')
  }

  const env = {
    ...process.env,
    AWS_PAGER: '',
    PAGER: '',
    ...(options.env || {}),
  }
  if (options.profile) env.AWS_PROFILE = options.profile

  const line = scrub(['aws', ...argv].map(quote).join(' '), secrets)

  if (options.dryRun) {
    if (options.log) options.log(line)
    else console.log(line)
    if (Object.prototype.hasOwnProperty.call(options, 'dryResult')) {
      return options.dryResult
    }
    try {
      return dryAwsReply(service, operation, args, options)
    } catch (error) {
      const detail = scrub(String(error.message || error), secrets)
      if (options.allowMissing && isMissing(detail)) return null
      if (options.allowError && options.allowError.test(detail)) return null
      throw error
    }
  }

  if (options.log && !options.silent) options.log(line)

  let stdout
  try {
    const result = await execFileAsync('aws', argv, {
      cwd: options.cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    })
    stdout = result.stdout
  } catch (error) {
    const detail = scrub(String(error.stderr || error.message || error), secrets)
    if (options.allowMissing && isMissing(detail)) return null
    if (options.allowError && options.allowError.test(detail)) return null
    const failure = new Error(`aws ${service} ${operation} failed: ${detail.trim()}`)
    failure.exitCode = error.code
    failure.stderr = detail
    throw failure
  }

  const text = String(stdout ?? '').trim()
  if (!text) return null
  if (options.raw) return text
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(
      `aws ${service} ${operation} did not answer with JSON: ${scrub(text.slice(0, 500), secrets)}`
    )
  }
}

export async function taskAddresses (tasks) {
  const attachment = t => (t.attachments || []).flatMap(a => a.details || []).find(d => d.name === 'networkInterfaceId')?.value
  const ids = [...new Set(tasks.map(attachment).filter(Boolean))]
  if (!ids.length) return new Map()
  const result = await aws(['ec2', 'describe-network-interfaces', '--filters', JSON.stringify([{ Name: 'network-interface-id', Values: ids }])])
  const addresses = new Map((result.NetworkInterfaces || []).map(eni => [eni.NetworkInterfaceId, eni.Association?.PublicIp]))
  return new Map(tasks.map(t => [t.taskArn, addresses.get(attachment(t))]))
}

export function blindPeerLogKey (event) {
  const match = /^blind-peer\/blind-peer\/([0-9a-f]{8}(?:[0-9a-f]{24})?)$/i.exec(event.logStreamName || '')
  if (!match) return null
  try {
    const log = JSON.parse(event.message)
    if (log.msg !== 'Listening' || typeof log.publicKey !== 'string') return null
    return { task: match[1].slice(0, 8).toLowerCase(), key: decodeZ32(log.publicKey) }
  } catch { return null }
}

export async function persistRunState (state, runDir) {
  await mkdir(runDir, { recursive: true, mode: 0o700 })
  const lockPath = path.join(runDir, '.lock')
  let lock
  for (let tries = 0; !lock && tries < 300; tries++) {
    try { lock = await open(lockPath, 'wx', 0o600) } catch (err) {
      if (err.code !== 'EEXIST') throw err
      try { if (Date.now() - (await stat(lockPath)).mtimeMs > 30000) await unlink(lockPath) } catch (e) { if (e.code !== 'ENOENT') throw e }
      await sleep(100)
    }
  }
  if (!lock) throw new Error('Run state is locked')
  try {
    let disk = {}
    try { disk = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8')) } catch (err) { if (err.code !== 'ENOENT') throw err }
    const tasks = new Map((disk.tasks || []).map(t => [t.taskArn, t]))
    for (const task of state.tasks || []) tasks.set(task.taskArn, { ...tasks.get(task.taskArn), ...task })
    const currentStep = Math.max(disk.currentStep || 0, state.currentStep || 0) || undefined
    const logBytes = Math.max(disk.logBytes || 0, state.logBytes || 0) || undefined
    Object.assign(state, { ...disk, ...state, currentStep, logBytes, tasks: [...tasks.values()], steps: { ...disk.steps, ...state.steps }, relayKeys: { ...disk.relayKeys, ...state.relayKeys } })
    const tmp = path.join(runDir, `run.${process.pid}.tmp`)
    await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, path.join(runDir, 'run.json'))
  } finally { await lock.close(); await unlink(lockPath) }
}

// Create every resource this run needs, in the order the test documentation lists.
// A resource that already exists is reused only when its exact run tag is present.
export async function up (ctx) {
  const opts = ctx.opts || {}
  const state = prepareState(ctx)
  const session = makeSession(ctx)
  if (!session.dry && !ctx.runDir) {
    throw new Error('ctx.runDir is required for the rendered task definitions')
  }
  const run = state.run
  const name = resourceName(run)
  const arch = normaliseArch(opts.arch || state.arch)
  const sizes = resolveSizes(opts)
  const durations = String(opts.stepMinutes || '45,40,40').split(',').map(Number)
  if (durations.length !== 3 || durations.some(n => !Number.isFinite(n) || n <= 0)) throw new Error('step-minutes needs three positive numbers')
  const deadlineMin = Math.ceil(durations.reduce((a, b) => a + b, 0) + 15)
  const bpShutdownMin = deadlineMin + 30
  const brTimeoutSec = deadlineMin * 60
  const retentionDays = 3
  const budgetUsd = 10
  const budgetAlertPercent = 80
  hex32(opts.ownerPub, 'owner-pub')
  if (typeof opts.budgetEmail !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(opts.budgetEmail)) throw new Error('budget-email is required')
  state.budgetEmail = opts.budgetEmail

  state.run = run
  state.region = session.region
  state.arch = arch
  state.name = name
  const keys = resolveRunKeys(ctx, session)
  state.ownerPub = keys.ownerPub
  state.scraperSeed = keys.scraperSeed
  state.scraperSecret = keys.scraperSecret
  state.scraperPublicKey = keys.scraperPublicKey
  await persist(ctx)

  session.say(`up ${run}: region ${session.region}, arch ${arch}`)

  const account = await getAccount(session)

  const subset = subsetOf(ctx)
  const replicateKeys = [...new Set(subset.entries.map((entry) => hex32(entry.blobs, 'subset entry blobs')))].join(',')
  const relayKeys = relayKeysOf(opts, session)
  const topicSeed = topicSeedOf(opts, run)

  const probeRepository = await ensureRepository(session, { name: `${name}/probe`, run })
  const relayRepository = await ensureRepository(session, { name: `${name}/blind-relay`, run })
  state.repositories = [probeRepository.name, relayRepository.name]
  await persist(ctx)
  await registryLogin(session, probeRepository.uri)
  const images = await ensureImages(session, ctx, { probeRepository, relayRepository, arch })
  state.images = images
  await persist(ctx)
  session.say(`images: peartube ${images.peartube}`)
  session.say(`images: blind peer ${images.blindPeer}`)
  session.say(`images: blind relay ${images.blindRelay}`)
  session.say(`images: probe ${images.probe}`)

  const role = await ensureExecutionRole(session, { name: `${name}-exec`, run })
  state.execRoleArn = role.arn
  await persist(ctx)
  session.say(`execution role: ${name}-exec`)

  const logGroup = await ensureLogGroup(session, {
    name: `/peartube-fargate-swarm/${run}`,
    run,
    account,
    retentionDays,
  })
  state.logGroup = logGroup
  await persist(ctx)

  const network = await ensureNetwork(session, { name, run })
  state.vpc = network.vpc
  state.subnets = network.subnets
  state.securityGroup = network.securityGroup
  state.securityGroupName = name
  await persist(ctx)
  session.say(`network: ${network.subnets.length} public subnet(s), security group ${network.securityGroup}`)

  const cluster = await ensureCluster(session, { name, run })
  state.cluster = cluster.name
  state.clusterArn = cluster.arn
  await persist(ctx)
  session.say(`cluster: ${cluster.name}`)


  const definitions = await registerTaskDefinitions(session, ctx, {
    name,
    run,
    account,
    sizes,
    images,
    execRoleArn: role.arn,
    logGroup,
    keys,
    subset,
    replicateKeys,
    relayKeys,
    topicSeed,
    deadlineMin,
    bpShutdownMin,
    brTimeoutSec,
  })
  state.taskDefinitions = definitions
  await persist(ctx)
  session.say(`task definitions: ${TASK_KEYS.length}`)

  const guard = await ensureBudgetAndAlert(session, {
    name,
    run,
    account,
    budgetUsd,
    budgetAlertPercent,
    budgetEmail: opts.budgetEmail,
  })
  state.budget = guard.budget
  await persist(ctx)

  session.say(`up complete: ${run}`)
  return state
}

// Stop and delete everything this run created. ctx.stop runs first. Every deletion
// is checked against the exact run tag; anything that does not match is reported
// and left alone.
export async function down (ctx) {
  const state = prepareState(ctx)
  const session = makeSession(ctx)
  if (session.dry) throw new Error('down does not support dry-run')
  const run = state.run, name = resourceName(run)
  await ctx.stop()
  const account = await getAccount(session)
  const cluster = await findCluster(session, name, run)
  if (cluster && !cluster.tagged) throw new Error('cluster tag does not match; it was left untouched')
  const failures = []
  const remove = async (label, action) => {
    try { await action(); session.say(`${label}: removed or absent`) } catch (error) { failures.push(`${label}: ${scrub(error.message)}`) }
  }
  await remove('task definitions', () => deleteTaskDefinitions(session, `${name}-`, run))
  if (cluster) await remove('cluster', () => deleteCluster(session, name, 120))
  await remove('log group', () => deleteLogGroup(session, { name: `/peartube-fargate-swarm/${run}`, run, account }))
  await remove('security group', () => deleteSecurityGroups(session, name, run, state.securityGroup, 120))
  await remove('execution role', () => deleteExecutionRole(session, `${name}-exec`, run))
  for (const kind of ['probe', 'blind-relay']) {
    await remove(`ECR ${kind}`, () => deleteRepository(session, `${name}/${kind}`, run))
  }
  await remove('budget', () => deleteBudget(session, { name, run, account }))
  if (failures.length) throw new Error(`down incomplete: ${failures.join('; ')}`)
  if (!(await check(ctx))) throw new Error('AWS still lists resources for this run')
  return state
}

// Include stopped tasks and task definitions being deleted in the inventory.
export async function check (ctx) {
  const state = prepareState(ctx), session = makeSession(ctx)
  if (session.dry) throw new Error('check cannot verify a dry run')
  const run = state.run, name = resourceName(run), left = []
  const account = await getAccount(session)
  const tagNote = tags => hasRunTag(tags, run) ? '' : ' (tag mismatch)'
  const clusters = await awsPages(session, ['ecs', 'list-clusters'], 'clusterArns')
  const clusterArn = clusters.find(arn => String(arn).split('/').pop() === name)
  if (clusterArn) {
    left.push(`ECS cluster ${name}${tagNote(await tagList(session, 'ecs', clusterArn))}`)
    for (const status of ['RUNNING', 'PENDING', 'STOPPED']) {
      for (const arn of await listTasks(session, name, status)) left.push(`ECS task ${shortTaskArn(arn)} (${status})`)
    }
  }
  for (const arn of await listTaskDefinitionArns(session, `${name}-`)) left.push(`task definition ${shortTaskDefinitionArn(arn)}`)
  const groups = await findSecurityGroups(session, name, state.securityGroup)
  const groupIds = new Set(groups.map(group => group.GroupId))
  if (state.securityGroup) groupIds.add(state.securityGroup)
  for (const group of groups) left.push(`security group ${group.GroupId}${tagNote(group.Tags)}`)
  for (const groupId of groupIds) {
    const reply = await session.aws(['ec2', 'describe-network-interfaces', '--filters', `Name=group-id,Values=${groupId}`])
    for (const eni of reply?.NetworkInterfaces || []) left.push(`network interface ${eni.NetworkInterfaceId}`)
  }
  const taggedEnis = await session.aws(['ec2', 'describe-network-interfaces', '--filters', `Name=tag:${TAG_KEY},Values=${run}`])
  for (const eni of taggedEnis?.NetworkInterfaces || []) {
    const label = `network interface ${eni.NetworkInterfaceId}`
    if (!left.includes(label)) left.push(label)
  }
  const logName = `/peartube-fargate-swarm/${run}`
  const logs = await session.aws(['logs', 'describe-log-groups', '--log-group-name-prefix', logName])
  const group = (logs?.logGroups || []).find(item => item.logGroupName === logName)
  if (group) {
    const arn = (group.arn || `arn:aws:logs:${session.region}:${account}:log-group:${logName}`).replace(/:\*$/, '')
    left.push(`log group ${logName}${tagNote(await tagList(session, 'logs', arn))}`)
  }
  const roleName = `${name}-exec`
  const role = await session.aws(['iam', 'get-role', '--role-name', roleName], { allowMissing: true })
  if (role?.Role) left.push(`IAM role ${roleName}${tagNote(role.Role.Tags)}`)
  for (const kind of ['probe', 'blind-relay']) {
    const repositoryName = `${name}/${kind}`
    const reply = await session.aws(['ecr', 'describe-repositories', '--repository-names', repositoryName], { allowMissing: true })
    const repository = reply?.repositories?.find(item => item.repositoryName === repositoryName)
    if (repository) left.push(`ECR ${kind}${tagNote(await tagList(session, 'ecr', repository.repositoryArn))}`)
  }
  const budget = await session.aws(['budgets', 'describe-budget', '--account-id', account, '--budget-name', name], { allowMissing: true })
  if (budget) left.push(`budget ${name}${tagNote(await tagList(session, 'budgets', `arn:aws:budgets::${account}:budget/${name}`))}`)
  for (const item of left) session.say(`left: ${item}`)
  session.say(left.length ? `${left.length} resource(s) remain` : 'NOTHING LEFT')
  return left.length === 0
}

// --- state and options -------------------------------------------------------

function prepareState (ctx) {
  if (!ctx.state || typeof ctx.state !== 'object') ctx.state = {}
  const state = ctx.state
  state.run = ctx.run || state.run
  if (!Array.isArray(state.tasks)) state.tasks = []
  if (!state.steps || typeof state.steps !== 'object') state.steps = {}
  if (!state.run) throw new Error('ctx.run is required')
  return state
}

function isDry (opts) {
  return Boolean(opts && (opts.dryRun || opts.dry))
}

function makeSession (ctx) {
  const opts = ctx.opts || {}
  const dry = isDry(opts)
  const quiet = Boolean(opts.quiet) && !dry
  const region = regionOf(ctx, dry)
  const session = {
    ctx,
    dry,
    quiet,
    region,
    say (text) {
      if (quiet) return
      console.log(scrub(text, secretsOf(ctx)))
    },
    aws (args, options = {}) {
      return aws(args, {
        region,
        dryRun: dry,
        run: ctx.run,
        profile: opts.profile,
        secrets: secretsOf(ctx),
        log: quiet ? null : (line) => console.log(scrub(line, secretsOf(ctx))),
        ...options,
      })
    },
    command (file, args, options = {}) {
      return runCommand(session, file, args, options)
    },
  }
  return session
}

async function runCommand (session, file, args, options = {}) {
  const cwd = options.cwd || REPO_ROOT
  const dryResult = options.dryResult ?? null
  const line = scrub([file, ...args].map(quote).join(' '), secretsOf(session.ctx))

  if (!session.quiet || session.dry) console.log(line)
  if (session.dry) return dryResult

  try {
    const result = await execFileAsync(file, args, {
      cwd,
      env: { ...process.env, AWS_PAGER: '', PAGER: '' },
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    })
    return String(result.stdout ?? '').trim()
  } catch (error) {
    const detail = scrub(String(error.stderr || error.message || error), secretsOf(session.ctx))
    const failure = new Error(`${file} ${args[0] || ''} failed: ${detail.trim()}`)
    failure.exitCode = error.code
    throw failure
  }
}

function regionOf (ctx, dry) {
  const opts = ctx.opts || {}
  // A saved region pins the run to the region where its resources live. An
  // explicit opts.region overrides it; the environment is the fallback for a
  // fresh run.
  const configured =
    opts.region ||
    (ctx.state && ctx.state.region) ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION
  if (configured) return configured
  if (dry) return 'us-east-2'
  throw new Error('set AWS_REGION (or opts.region)')
}

function normaliseArch (value) {
  const arch = String(value || 'amd64').toLowerCase()
  if (arch === 'x86_64' || arch === 'x86-64' || arch === 'amd64') return 'amd64'
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64'
  throw new Error(`unsupported architecture ${value}; use amd64 or arm64`)
}

function resourceName (run) {
  // ECR repository names cannot end with a hyphen, so the run cannot either.
  if (typeof run !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/.test(run)) {
    throw new Error(
      'run must be 1 to 31 lowercase letters, digits or hyphens, start and end with a letter or digit'
    )
  }
  return `${NAME_PREFIX}${run}`
}

function resolveSizes (opts) {
  const given = opts.sizes || {}
  for (const key of Object.keys(given)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SIZES, key)) {
      throw new Error(`unknown sizes key ${key}`)
    }
  }
  const sizes = {}
  for (const [key, defaults] of Object.entries(DEFAULT_SIZES)) {
    const chosen = { ...defaults, ...(given[key] || {}) }
    const cpu = Number(chosen.cpu)
    const memory = Number(chosen.memory)
    if (!Number.isInteger(cpu) || !Number.isInteger(memory) || !fargateSizeAllowed(cpu, memory)) {
      throw new Error(`invalid Fargate size for ${key}: cpu ${chosen.cpu}, memory ${chosen.memory}`)
    }
    sizes[key] = { cpu: String(cpu), memory: String(memory) }
  }
  return sizes
}

function fargateSizeAllowed (cpu, memory) {
  switch (cpu) {
    case 256:
      return [512, 1024, 2048].includes(memory)
    case 512:
      return [1024, 2048, 3072, 4096].includes(memory)
    case 1024:
      return memory >= 2048 && memory <= 8192 && memory % 1024 === 0
    case 2048:
      return memory >= 4096 && memory <= 16384 && memory % 1024 === 0
    case 4096:
      return memory >= 8192 && memory <= 30720 && memory % 1024 === 0
    case 8192:
      return memory >= 16384 && memory <= 61440 && memory % 4096 === 0
    case 16384:
      return memory >= 32768 && memory <= 122880 && memory % 8192 === 0
    case 32768:
      return [61440, 122880, 249856].includes(memory)
    default:
      return false
  }
}


function subsetOf (ctx) {
  const subset = ctx.subset
  if (!subset || typeof subset !== 'object') {
    throw new Error('ctx.subset is required; run prepare first')
  }
  hex32(subset.channel, 'subset channel')
  if (!Array.isArray(subset.entries) || subset.entries.length === 0) {
    throw new Error('subset has no entries')
  }
  for (const [index, entry] of subset.entries.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`subset entry ${index} is not an object`)
    }
    hex32(entry.blobs, `subset entry ${index} blobs`)
  }
  return subset
}

function relayKeysOf (opts, _session) {
  const raw = opts.relayKeys
  if (!raw) return ''
  const parts = Array.isArray(raw) ? raw : String(raw).split(',')
  const keys = []
  for (const part of parts) {
    const value = String(part).trim()
    if (!value) continue
    const key = decodeZ32(value)
    if (!keys.includes(key)) keys.push(key)
  }
  return keys.join(',')
}

function topicSeedOf (opts, run) {
  const seed = String(opts.topicSeed ?? run)
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(seed)) {
    throw new Error('topicSeed must be 1 to 200 letters, digits or . _ : -')
  }
  return seed
}

function hex32 (value, what) {
  const text = String(value ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new Error(`${what} must be 64 hex characters (32 bytes)`)
  }
  return text
}

function ed25519PublicKeyHex (seedHex) {
  const seed = Buffer.from(seedHex, 'hex')
  if (seed.length !== 32) throw new Error('an Ed25519 seed is 32 bytes')
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' })
  if (spki.length !== 44) throw new Error('cannot derive an Ed25519 public key')
  return Buffer.from(spki.subarray(spki.length - 32)).toString('hex')
}

function resolveRunKeys (ctx, session) {
  const ownerPub = hex32(ctx.opts.ownerPub, 'owner-pub')
  if (ctx.state.ownerPub && ctx.state.ownerPub !== ownerPub) throw new Error('owner-pub does not match this run')
  if (session.dry) return { ownerPub, scraperSeed: '0'.repeat(64), scraperSecret: '1'.repeat(64), scraperPublicKey: '2'.repeat(64) }
  const scraperSeed = hex32(ctx.state.scraperSeed || randomBytes(32).toString('hex'), 'scraper seed')
  const scraperSecret = hex32(ctx.state.scraperSecret || randomBytes(32).toString('hex'), 'scraper secret')
  const scraperPublicKey = ed25519PublicKeyHex(scraperSeed)
  if (ctx.state.scraperPublicKey && ctx.state.scraperPublicKey !== scraperPublicKey) throw new Error('scraper public key does not match its seed')
  return { ownerPub, scraperSeed, scraperSecret, scraperPublicKey }
}

async function persist (ctx) {
  if (isDry(ctx.opts) || typeof ctx.save !== 'function') return
  await ctx.save()
}

async function getAccount (session) {
  if (session.dry) {
    await session.aws(['sts', 'get-caller-identity'])
    return 'ACCOUNT'
  }
  const identity = await session.aws(['sts', 'get-caller-identity'], { silent: true })
  const account = identity?.Account
  if (!/^\d{12}$/.test(account || '')) {
    throw new Error('sts get-caller-identity returned no account id')
  }
  return account
}

// --- ECR and images ----------------------------------------------------------

async function ensureRepository (session, { name, run }) {
  const found = await session.aws(['ecr', 'describe-repositories', '--repository-names', name], {
    allowMissing: true,
  })
  const repository = found?.repositories?.[0]
  if (repository) {
    assertTagged(
      session,
      'ECR repository',
      name,
      await tagList(session, 'ecr', repository.repositoryArn),
      run
    )
    if (repository.repositoryName !== name) {
      throw new Error(`ECR repository name ${repository.repositoryName} does not match ${name}`)
    }
    return { name, uri: repository.repositoryUri, arn: repository.repositoryArn }
  }

  const created = await session.aws(
    [
      'ecr',
      'create-repository',
      '--repository-name',
      name,
      '--image-scanning-configuration',
      'scanOnPush=true',
      '--encryption-configuration',
      'encryptionType=AES256',
      '--tags',
      `Key=${TAG_KEY},Value=${run}`,
    ],
    {
      dryResult: {
        repository: {
          repositoryName: name,
          repositoryArn: `arn:aws:ecr:${session.region}:ACCOUNT:repository/${name}`,
          repositoryUri: `ACCOUNT.dkr.ecr.${session.region}.amazonaws.com/${name}`,
        },
      },
    }
  )
  return {
    name,
    uri: created.repository.repositoryUri,
    arn: created.repository.repositoryArn,
  }
}

async function registryLogin (session, repositoryUri) {
  const registry = repositoryUri.split('/')[0]
  const answer = await session.aws(['ecr', 'get-login-password'], { silent: true, raw: true })
  let password = String(answer ?? '')
  if (password.startsWith('"') && password.endsWith('"')) {
    try {
      password = JSON.parse(password)
    } catch {
      // Keep the raw text when the CLI did not quote a JSON string.
    }
  }
  if (!password) {
    throw new Error('ecr get-login-password returned no password')
  }
  await dockerLogin(session, registry, password)
}

async function ensureImages (session, ctx, { probeRepository, relayRepository, arch }) {
  const platform = arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'
  const commit = ctx.opts.ptImage ? null : session.dry ? await dryMergeBase(session) : await gitMergeBase(session)
  const peartube = ctx.opts.ptImage || `ghcr.io/ayooooo123/peartube-relay:sha-${commit}`
  const probe = await ensureBuiltImage(session, {
    repositoryName: probeRepository.name, repositoryUri: probeRepository.uri, tag: arch,
    dockerfile: 'test/fargate/probe/Dockerfile', context: 'test/fargate/probe', platform
  })
  const blindRelay = await ensureBuiltImage(session, {
    repositoryName: relayRepository.name, repositoryUri: relayRepository.uri, tag: arch,
    dockerfile: 'test/fargate/blind-relay/Dockerfile', context: 'test/fargate/blind-relay', platform
  })
  return { peartube, blindPeer: BLIND_PEER_IMAGE, blindRelay, probe }
}

async function ensureBuiltImage (
  session,
  { repositoryName, repositoryUri, tag, dockerfile, context, platform, force }
) {
  const uri = `${repositoryUri}:${tag}`
  if (!force) {
    const found = await session.aws(
      [
        'ecr',
        'describe-images',
        '--repository-name',
        repositoryName,
        '--image-ids',
        `imageTag=${tag}`,
      ],
      { allowMissing: true }
    )
    if (found?.imageDetails?.length) {
      session.say(`image ${tag}: reusing ${uri}`)
      return uri
    }
  }
  await buildAndPush(session, { uri, dockerfile, context, platform })
  return uri
}


async function dryMergeBase (session) {
  await session.command('git', ['-C', '.', 'merge-base', 'HEAD', 'origin/main'], {
    dryResult: '0'.repeat(40),
  })
  return '0'.repeat(40)
}

async function gitMergeBase (session) {
  const output = await session.command('git', ['-C', '.', 'merge-base', 'HEAD', 'origin/main'])
  if (!/^[0-9a-f]{40}$/.test(output)) throw new Error('cannot find the base commit; pass --pt-image')
  return output
}

async function buildAndPush (session, { uri, dockerfile, context, platform }) {
  try {
    await session.command('docker', [
      'buildx',
      'build',
      '--platform',
      platform,
      '--tag',
      uri,
      '--file',
      dockerfile,
      '--push',
      context,
    ])
  } catch (error) {
    if (!/buildx/i.test(error.message)) throw error
    session.say('docker buildx is unavailable; falling back to docker build and docker push')
    await session.command('docker', [
      'build',
      '--platform',
      platform,
      '--tag',
      uri,
      '--file',
      dockerfile,
      context,
    ])
    await session.command('docker', ['push', uri])
  }
}

async function dockerLogin (session, registry, password) {
  const line = `docker login --username AWS --password-stdin ${quote(registry)}`
  if (!session.quiet || session.dry) {
    console.log(scrub(line, secretsOf(session.ctx)))
  }
  if (session.dry) return

  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['login', '--username', 'AWS', '--password-stdin', registry], {
      env: { ...process.env, AWS_PAGER: '', PAGER: '' },
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let errorText = ''
    child.stderr.on('data', (chunk) => {
      errorText += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else {
        reject(
          new Error(
            scrub(`docker login failed: ${errorText.trim()}`, [
              ...secretsOf(session.ctx),
              password,
            ])
          )
        )
      }
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(password)
  })
}

// --- IAM, logs, network, cluster --------------------------------------------

async function ensureExecutionRole (session, { name, run }) {
  const existing = await session.aws(['iam', 'get-role', '--role-name', name], {
    allowMissing: true,
  })
  if (existing?.Role) {
    assertTagged(session, 'IAM role', name, existing.Role.Tags, run)
    assertEcsTrust(existing.Role.AssumeRolePolicyDocument)
    await attachExecutionPolicy(session, name)
    return { arn: existing.Role.Arn }
  }

  const created = await session.aws(
    [
      'iam',
      'create-role',
      '--role-name',
      name,
      '--description',
      `Fargate swarm test ${run}`,
      '--assume-role-policy-document',
      JSON.stringify(TRUST_POLICY),
      '--tags',
      `Key=${TAG_KEY},Value=${run}`,
    ],
    { dryResult: { Role: { Arn: `arn:aws:iam::ACCOUNT:role/${name}` } } }
  )
  await attachExecutionPolicy(session, name)
  return { arn: created.Role.Arn }
}

function assertEcsTrust (document) {
  const text =
    typeof document === 'string'
      ? (() => {
          try {
            return decodeURIComponent(document)
          } catch {
            return document
          }
        })()
      : JSON.stringify(document || {})
  if (!text.includes('ecs-tasks.amazonaws.com')) {
    throw new Error('the execution role trust policy does not allow ecs-tasks.amazonaws.com')
  }
}

async function attachExecutionPolicy (session, name) {
  const attached = await session.aws(
    ['iam', 'list-attached-role-policies', '--role-name', name],
    { dryResult: { AttachedPolicies: [] } }
  )
  const hasPolicy = (attached?.AttachedPolicies || []).some(
    (policy) => policy.PolicyArn === EXECUTION_POLICY
  )
  if (!hasPolicy) {
    await session.aws(
      ['iam', 'attach-role-policy', '--role-name', name, '--policy-arn', EXECUTION_POLICY],
      { dryResult: {} }
    )
  }
}

async function ensureLogGroup (session, { name, run, account, retentionDays }) {
  const reply = await session.aws(
    ['logs', 'describe-log-groups', '--log-group-name-prefix', name],
    { dryResult: { logGroups: [] } }
  )
  const found = (reply?.logGroups || []).find((group) => group.logGroupName === name)

  if (found) {
    const arn = (found.arn || `arn:aws:logs:${session.region}:${account}:log-group:${name}`).replace(/:\*$/, '')
    assertTagged(session, 'log group', name, await tagList(session, 'logs', arn), run)
  } else {
    await session.aws(
      ['logs', 'create-log-group', '--log-group-name', name, '--tags', `${TAG_KEY}=${run}`],
      { dryResult: {} }
    )
  }

  await session.aws(
    [
      'logs',
      'put-retention-policy',
      '--log-group-name',
      name,
      '--retention-in-days',
      String(retentionDays),
    ],
    { dryResult: {} }
  )
  return name
}

async function ensureNetwork (session, { name, run }) {
  const vpcs = await session.aws(
    ['ec2', 'describe-vpcs', '--filters', 'Name=is-default,Values=true'],
    { dryResult: { Vpcs: [{ VpcId: 'vpc-PLACEHOLDER' }] } }
  )
  const vpc = vpcs?.Vpcs?.[0]?.VpcId
  if (!vpc) {
    throw new Error('this region has no default VPC; the test needs the default VPC')
  }

  const subnets = await chooseSubnets(session, vpc)
  const securityGroup = await ensureSecurityGroup(session, { name, run, vpc })
  return { vpc, subnets, securityGroup }
}

async function chooseSubnets (session, vpc) {
  const reply = await session.aws(
    ['ec2', 'describe-subnets', '--filters', `Name=vpc-id,Values=${vpc}`, 'Name=default-for-az,Values=true'],
    { dryResult: { Subnets: [
      { SubnetId: 'subnet-PLACEHOLDER-1', AvailabilityZone: 'us-east-2a' },
      { SubnetId: 'subnet-PLACEHOLDER-2', AvailabilityZone: 'us-east-2b' },
      { SubnetId: 'subnet-PLACEHOLDER-3', AvailabilityZone: 'us-east-2c' }
    ] } }
  )
  const subnets = (reply?.Subnets || []).filter(subnet => !subnet.State || subnet.State === 'available')
    .sort((a, b) => String(a.AvailabilityZone).localeCompare(String(b.AvailabilityZone)))
  if (subnets.length < 3) throw new Error('the default VPC needs three default subnets')
  return subnets.slice(0, 3).map(subnet => subnet.SubnetId)
}

async function ensureSecurityGroup (session, { name, run, vpc }) {
  const reply = await session.aws(
    [
      'ec2',
      'describe-security-groups',
      '--filters',
      `Name=group-name,Values=${name}`,
      `Name=vpc-id,Values=${vpc}`,
    ],
    { dryResult: { SecurityGroups: [] } }
  )
  const found = (reply?.SecurityGroups || []).find((group) => group.GroupName === name)

  if (found) {
    assertTagged(session, 'security group', name, found.Tags, run)
    const inbound = (found.IpPermissions || []).length
    if (inbound > 0) {
      throw new Error(
        `security group ${name} has ${inbound} inbound rule(s); this test requires no inbound rules`
      )
    }
    if (!allowsAllEgress(found.IpPermissionsEgress)) {
      await session.aws(
        [
          'ec2',
          'authorize-security-group-egress',
          '--group-id',
          found.GroupId,
          '--ip-permissions',
          EGRESS_PERMISSIONS,
        ],
        { dryResult: {} }
      )
    }
    return found.GroupId
  }

  const created = await session.aws(
    [
      'ec2',
      'create-security-group',
      '--group-name',
      name,
      '--description',
      `Fargate swarm test ${run}: no inbound rules`,
      '--vpc-id',
      vpc,
      '--tag-specifications',
      `ResourceType=security-group,Tags=[{Key=${TAG_KEY},Value=${run}}]`,
    ],
    { dryResult: { GroupId: 'sg-PLACEHOLDER' } }
  )
  return created.GroupId
}

function allowsAllEgress (rules) {
  return (rules || []).some(
    (rule) =>
      String(rule.IpProtocol) === '-1' &&
      (rule.IpRanges || []).some((range) => range.CidrIp === '0.0.0.0/0')
  )
}

async function ensureCluster (session, { name, run }) {
  const reply = await session.aws(['ecs', 'describe-clusters', '--clusters', name, '--include', 'SETTINGS'], {
    dryResult: { clusters: [], failures: [] },
  })
  const cluster = (reply?.clusters || [])[0]

  if (cluster) {
    assertTagged(
      session,
      'ECS cluster',
      name,
      await tagList(session, 'ecs', cluster.clusterArn),
      run
    )
    if (cluster.status && cluster.status !== 'ACTIVE') {
      throw new Error(`ECS cluster ${name} is ${cluster.status}; refusing to reuse it`)
    }
    if (cluster.settings?.find(setting => setting.name === 'containerInsights')?.value !== 'disabled') {
      await session.aws(['ecs', 'update-cluster-settings', '--cluster', name, '--settings', 'name=containerInsights,value=disabled'])
    }
    return { name, arn: cluster.clusterArn }
  }

  const created = await session.aws(
    ['ecs', 'create-cluster', '--cluster-name', name, '--settings', 'name=containerInsights,value=disabled', '--tags', `key=${TAG_KEY},value=${run}`],
    {
      dryResult: {
        cluster: {
          clusterName: name,
          clusterArn: `arn:aws:ecs:${session.region}:ACCOUNT:cluster/${name}`,
          status: 'ACTIVE',
        },
      },
    }
  )
  return { name, arn: created.cluster.clusterArn }
}

// --- task definitions --------------------------------------------------------

async function registerTaskDefinitions (
  session,
  ctx,
  {
    name,
    run,
    account,
    sizes,
    images,
    execRoleArn,
    logGroup,
    keys,
    subset,
    replicateKeys,
    relayKeys,
    topicSeed,
    deadlineMin,
    bpShutdownMin,
    brTimeoutSec,
  }
) {
  const rules = [
    {
      key: 'peartube',
      family: `${name}-peartube`,
      template: 'peartube.json',
      kind: 'peartube',
      role: 'pt-direct',
      relayThrough: false,
      size: sizes.peartube,
    },
    {
      key: 'peartube-relayed',
      family: `${name}-peartube-relayed`,
      template: 'peartube.json',
      kind: 'peartube',
      role: 'pt-relayed',
      relayThrough: true,
      size: sizes.peartube,
    },
    {
      key: 'blind-peer',
      family: `${name}-blind-peer`,
      template: 'blind-peer.json',
      kind: 'blind-peer',
      role: 'bp',
      size: sizes.blindPeer,
    },
    {
      key: 'blind-relay',
      family: `${name}-blind-relay`,
      template: 'blind-relay.json',
      kind: 'blind-relay',
      role: 'br',
      size: sizes.blindRelay,
    },
    {
      key: 'relayed-peer',
      family: `${name}-relayed-peer`,
      template: 'relayed-peer.json',
      kind: 'relayed-peer',
      role: 'rp',
      size: sizes.relayedPeer,
    },
  ]

  // Every existing revision under this run's prefix must carry the run tag before
  // a new revision is registered. An untagged family with our name is a conflict.
  const existing = await listTaskDefinitionArns(session, `${name}-`)
  for (const arn of existing) {
    const status = await taskDefinitionStatus(session, arn)
    if (status === null || status === 'DELETE_IN_PROGRESS') continue
    assertTagged(
      session,
      'task definition',
      arn,
      await tagList(session, 'ecs', arn),
      run
    )
  }

  const values = {
    RUN: run,
    IMAGE_PT: images.peartube,
    IMAGE_BP: images.blindPeer,
    IMAGE_BR: images.blindRelay,
    IMAGE_PROBE: images.probe,
    EXEC_ROLE_ARN: execRoleArn,
    LOG_GROUP: logGroup,
    AWS_REGION: session.region,
    CHANNEL_KEY: subset.channel,
    REPLICATE_KEYS: replicateKeys,
    RELAY_KEYS: relayKeys,
    OWNER_PUB: keys.ownerPub,
    SCRAPER_PUB: keys.scraperPublicKey,
    SCRAPER_SECRET: keys.scraperSecret,
    DEADLINE_MIN: String(deadlineMin),
    BP_SHUTDOWN_MIN: String(bpShutdownMin),
    BR_TIMEOUT_SEC: String(brTimeoutSec),
    TOPIC_SEED: topicSeed,
    SUBSET_JSON: JSON.stringify(subset),
  }

  const definitions = {}
  if (!session.dry) {
    await mkdir(ctx.runDir, { recursive: true, mode: 0o700 })
  }

  for (const rule of rules) {
    const ruleValues = { ...values, CPU: rule.size.cpu, MEMORY: rule.size.memory }
    const document = await renderTaskDefinition(session, ctx, rule, ruleValues)
    const arn = `arn:aws:ecs:${session.region}:${account}:task-definition/${rule.family}:1`
    const previous = await session.aws(['ecs', 'describe-task-definition', '--task-definition', rule.family, '--include', 'TAGS'],
      { allowError: /Unable to describe task definition|not found/i, dryResult: null })
    if (previous?.taskDefinition?.status === 'ACTIVE') {
      assertTagged(session, 'task definition', rule.family, previous.tags, run)
      const { tags, ...expected } = document
      if (matchesDefinition(expected, previous.taskDefinition)) {
        definitions[rule.key] = previous.taskDefinition.taskDefinitionArn
        session.say(`task definition ${rule.key}: reused`)
        continue
      }
    }

    if (session.dry) {
      session.say(`rendered task definition ${rule.family}`)
      session.say(JSON.stringify(document, null, 2))
    } else {
      const file = path.join(ctx.runDir, `taskdef-${rule.key}.json`)
      await writeFile(file, JSON.stringify(document), { mode: 0o600 })
    }

    const reply = await session.aws(
      [
        'ecs',
        'register-task-definition',
        '--cli-input-json',
        `file://taskdef-${rule.key}.json`,
      ],
      {
        cwd: session.dry ? undefined : ctx.runDir,
        dryResult: {
          taskDefinition: {
            taskDefinitionArn: arn,
            family: rule.family,
            revision: 1,
          },
        },
      }
    )
    definitions[rule.key] = reply.taskDefinition.taskDefinitionArn
    session.say(`task definition ${rule.key}: ${definitions[rule.key]}`)
  }

  return definitions
}

function matchesDefinition (expected, actual) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length &&
    expected.every((item, index) => matchesDefinition(item, actual[index]))
  if (expected && typeof expected === 'object') return actual && typeof actual === 'object' &&
    Object.keys(expected).every(key => matchesDefinition(expected[key], actual[key]))
  return expected === actual
}

async function renderTaskDefinition (_session, ctx, rule, values) {
  const raw = await readFile(path.join(TASK_DIR, rule.template), 'utf8')
  const document = JSON.parse(raw)
  substitute(document, values)

  document.family = rule.family
  document.tags = [{ key: TAG_KEY, value: ctx.state.run }]
  document.runtimePlatform = {
    cpuArchitecture: ctx.state.arch === 'arm64' ? 'ARM64' : 'X86_64',
    operatingSystemFamily: 'LINUX',
  }
  document.cpu = rule.size.cpu
  document.memory = rule.size.memory

  const probe = document.containerDefinitions.find((container) => container.name === 'probe')
  if (!probe) throw new Error(`${rule.template} has no probe container`)
  setEnvironment(probe, 'KIND', rule.kind)
  setEnvironment(probe, 'ROLE', rule.role)


  if (rule.key === 'peartube' || rule.key === 'peartube-relayed') {
    const relay = document.containerDefinitions.find((container) => container.name === 'peartube')
    if (!relay) throw new Error('peartube.json has no peartube container')
    if (!rule.relayThrough) removeEnvironment(relay, 'PEARTUBE_RELAY_THROUGH')
  }

  validateEnvironment(document)
  return document
}

function substitute (value, values) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (whole, name) => {
      if (!Object.prototype.hasOwnProperty.call(values, name) || values[name] === undefined) {
        throw new Error(`unknown task definition placeholder ${whole}`)
      }
      return String(values[name])
    })
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = substitute(value[index], values)
    }
    return value
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      value[key] = substitute(value[key], values)
    }
    return value
  }
  return value
}

function setEnvironment (container, name, value) {
  if (!Array.isArray(container.environment)) container.environment = []
  const entry = container.environment.find((item) => item.name === name)
  if (entry) entry.value = value
  else container.environment.push({ name, value })
}

function removeEnvironment (container, name) {
  if (!Array.isArray(container.environment)) return
  container.environment = container.environment.filter((item) => item.name !== name)
}

function validateEnvironment (document) {
  for (const container of document.containerDefinitions || []) {
    for (const entry of container.environment || []) {
      if (typeof entry.value !== 'string') throw new Error(`${document.family}: environment ${entry.name} is not a string`)
      const bytes = Buffer.byteLength(entry.value)
      if (bytes > 8192) throw new Error(`${document.family}: environment ${entry.name} is ${bytes} bytes; the limit is 8192`)
    }
  }
}

// --- budget and alert --------------------------------------------------------

async function ensureBudgetAndAlert (session, { name, run, account, budgetUsd, budgetAlertPercent, budgetEmail }) {
  const budgetArn = `arn:aws:budgets::${account}:budget/${name}`
  const budget = {
    BudgetName: name, BudgetLimit: { Amount: String(budgetUsd), Unit: 'USD' },
    TimeUnit: 'MONTHLY', BudgetType: 'COST',
    CostTypes: { IncludeCredit: false, IncludeRefund: false }
  }
  const notification = {
    NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN',
    Threshold: budgetAlertPercent, ThresholdType: 'PERCENTAGE'
  }
  const subscriber = { SubscriptionType: 'EMAIL', Address: budgetEmail }
  const existing = await session.aws(['budgets', 'describe-budget', '--account-id', account, '--budget-name', name], { allowMissing: true })
  if (!existing) {
    await session.aws(['budgets', 'create-budget', '--account-id', account, '--budget', JSON.stringify(budget),
      '--notifications-with-subscribers', JSON.stringify([{ Notification: notification, Subscribers: [subscriber] }]),
      '--resource-tags', `Key=${TAG_KEY},Value=${run}`], { dryResult: {} })
  } else {
    assertTagged(session, 'budget', name, await tagList(session, 'budgets', budgetArn), run)
    await session.aws(['budgets', 'update-budget', '--account-id', account, '--budget', JSON.stringify(budget)])
    const reply = await session.aws(['budgets', 'describe-notifications-for-budget', '--account-id', account, '--budget-name', name])
    const found = (reply?.Notifications || []).find(item => item.NotificationType === 'ACTUAL' &&
      item.ComparisonOperator === 'GREATER_THAN' && item.Threshold === budgetAlertPercent && item.ThresholdType === 'PERCENTAGE')
    if (!found) {
      await session.aws(['budgets', 'create-notification', '--account-id', account, '--budget-name', name,
        '--notification', JSON.stringify(notification), '--subscribers', JSON.stringify([subscriber])])
    } else {
      const subscribers = await session.aws(['budgets', 'describe-subscribers-for-notification', '--account-id', account,
        '--budget-name', name, '--notification', JSON.stringify(found)])
      if (!(subscribers?.Subscribers || []).some(item => item.SubscriptionType === 'EMAIL' && item.Address === budgetEmail)) {
        await session.aws(['budgets', 'create-subscriber', '--account-id', account, '--budget-name', name,
          '--notification', JSON.stringify(found), '--subscriber', JSON.stringify(subscriber)])
      }
    }
  }
  return { budget: name }
}


// --- down helpers ------------------------------------------------------------


async function findCluster (session, name, run) {
  const reply = await session.aws(['ecs', 'describe-clusters', '--clusters', name], {
    allowMissing: true,
    dryResult: { clusters: [], failures: [] },
  })
  const cluster = (reply?.clusters || [])[0]
  if (!cluster || cluster.status === 'INACTIVE') return null
  const tags = await tagList(session, 'ecs', cluster.clusterArn)
  return { ...cluster, tagged: hasRunTag(tags, run) }
}



async function deleteCluster (session, name, waitSeconds) {
  await session.aws(['ecs', 'delete-cluster', '--cluster', name], {
    allowMissing: true,
    dryResult: {},
  })
  const gone = await waitUntil(
    session,
    `ECS cluster ${name} to disappear`,
    Math.min(waitSeconds * 1000, 120000),
    async () => {
      const reply = await session.aws(['ecs', 'describe-clusters', '--clusters', name], {
        allowMissing: true,
        dryResult: { clusters: [], failures: [] },
      })
      return (reply?.clusters || []).every(cluster => cluster.status === 'INACTIVE')
    }
  )
  if (!gone) throw new Error(`ECS cluster ${name} is still visible`)
}

async function listTasks (session, cluster, status) {
  return awsPages(
    session,
    ['ecs', 'list-tasks', '--cluster', cluster, '--desired-status', status],
    'taskArns'
  )
}

async function deleteTaskDefinitions (session, prefix, run, waitSeconds) {
  const arns = await listTaskDefinitionArns(session, prefix)
  if (arns.length === 0) return

  // Ask each revision's status first. A revision that is already being deleted is
  // left alone; it has no deletion of ours to validate and it will disappear.
  const tagged = []
  for (const arn of arns) {
    const status = await taskDefinitionStatus(session, arn)
    if (status === null || status === 'DELETE_IN_PROGRESS') continue
    const tags = await tagList(session, 'ecs', arn)
    assertTagged(session, 'task definition', arn, tags, run)
    tagged.push({ arn, status })
  }

  const toDelete = []
  for (const { arn, status } of tagged) {
    if (status !== 'INACTIVE') {
      await session.aws(['ecs', 'deregister-task-definition', '--task-definition', arn], {
        allowMissing: true,
        dryResult: {},
      })
    }
    toDelete.push(arn)
  }

  for (let index = 0; index < toDelete.length; index += 10) {
    const result = await session.aws(
      ['ecs', 'delete-task-definitions', '--task-definitions', ...toDelete.slice(index, index + 10)],
      { allowMissing: true, dryResult: {} }
    )
    if (result?.failures?.length) throw new Error('ECS could not delete every task definition')
  }

}

async function taskDefinitionStatus (session, arn) {
  const reply = await session.aws(
    ['ecs', 'describe-task-definition', '--task-definition', arn],
    { allowMissing: true, dryResult: { taskDefinition: { status: 'ACTIVE' } } }
  )
  return reply?.taskDefinition?.status ?? null
}

async function listTaskDefinitionArns (session, prefix) {
  const seen = new Set()
  for (const status of ['ACTIVE', 'INACTIVE', 'DELETE_IN_PROGRESS']) {
    const arns = await awsPages(
      session,
      ['ecs', 'list-task-definitions', '--family-prefix', prefix, '--status', status],
      'taskDefinitionArns'
    )
    for (const arn of arns) {
      const family = String(arn).split('/').pop().split(':')[0]
      if (TASK_KEYS.some(kind => family === prefix + kind)) seen.add(arn)
    }
  }
  return [...seen].sort()
}

async function findSecurityGroups (session, name, idHint) {
  const groups = new Map()
  if (idHint) {
    const byId = await session.aws(
      ['ec2', 'describe-security-groups', '--group-ids', idHint],
      { allowMissing: true, dryResult: { SecurityGroups: [] } }
    )
    for (const group of byId?.SecurityGroups || []) if (group.GroupName === name) groups.set(group.GroupId, group)
  }
  const byName = await session.aws(
    ['ec2', 'describe-security-groups', '--filters', `Name=group-name,Values=${name}`],
    { dryResult: { SecurityGroups: [] } }
  )
  for (const group of byName?.SecurityGroups || []) {
    if (group.GroupName === name) groups.set(group.GroupId, group)
  }
  return [...groups.values()]
}

async function deleteSecurityGroups (session, name, run, idHint, waitSeconds) {
  const groups = await findSecurityGroups(session, name, idHint)
  if (groups.length === 0) return

  // Check every tag before deleting any of them.
  for (const group of groups) {
    assertTagged(session, 'security group', group.GroupId, group.Tags, run)
  }

  for (const group of groups) {
    const free = await waitUntil(
      session,
      `network interfaces on ${group.GroupId}`,
      waitSeconds * 1000,
      async () => {
        const reply = await session.aws(
          [
            'ec2',
            'describe-network-interfaces',
            '--filters',
            `Name=group-id,Values=${group.GroupId}`,
          ],
          { dryResult: { NetworkInterfaces: [] } }
        )
        return (reply?.NetworkInterfaces || []).length === 0
      }
    )
    if (!free) {
      throw new Error(`network interfaces still use ${group.GroupId}; it was not deleted`)
    }
    await deleteSecurityGroupWithRetry(session, group.GroupId)
  }
}

async function deleteSecurityGroupWithRetry (session, groupId) {
  let lastError = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await session.aws(['ec2', 'delete-security-group', '--group-id', groupId], {
        allowMissing: true,
        dryResult: {},
      })
      return
    } catch (error) {
      lastError = error
      if (!/DependencyViolation/i.test(error.message)) throw error
      await sleep(3000)
    }
  }
  throw lastError
}

async function deleteLogGroup (session, { name, run, account }) {
  const reply = await session.aws(
    ['logs', 'describe-log-groups', '--log-group-name-prefix', name],
    { dryResult: { logGroups: [] } }
  )
  const found = (reply?.logGroups || []).find((group) => group.logGroupName === name)
  if (!found) return

  const arn = (found.arn || `arn:aws:logs:${session.region}:${account}:log-group:${name}`).replace(/:\*$/, '')
  assertTagged(session, 'log group', name, await tagList(session, 'logs', arn), run)
  await session.aws(['logs', 'delete-log-group', '--log-group-name', name], {
    allowMissing: true,
    dryResult: {},
  })
}

async function deleteExecutionRole (session, name, run) {
  const reply = await session.aws(['iam', 'get-role', '--role-name', name], {
    allowMissing: true,
  })
  if (!reply?.Role) return
  assertTagged(session, 'IAM role', name, reply.Role.Tags, run)

  const attached = await session.aws(
    ['iam', 'list-attached-role-policies', '--role-name', name],
    { dryResult: { AttachedPolicies: [] } }
  )
  const inline = await session.aws(['iam', 'list-role-policies', '--role-name', name], {
    dryResult: { PolicyNames: [] }
  })
  if ((attached?.AttachedPolicies || []).some(policy => policy.PolicyArn !== EXECUTION_POLICY) ||
      (inline?.PolicyNames || []).length) throw new Error('execution role has other policies; it was left untouched')
  if ((attached?.AttachedPolicies || []).some(policy => policy.PolicyArn === EXECUTION_POLICY)) {
    await session.aws(['iam', 'detach-role-policy', '--role-name', name, '--policy-arn', EXECUTION_POLICY], { dryResult: {} })
  }

  await session.aws(['iam', 'delete-role', '--role-name', name], {
    allowMissing: true,
    dryResult: {},
  })
}

async function deleteRepository (session, name, run) {
  const reply = await session.aws(
    ['ecr', 'describe-repositories', '--repository-names', name],
    { allowMissing: true }
  )
  const repository = reply?.repositories?.[0]
  if (!repository) return
  assertTagged(
    session,
    'ECR repository',
    name,
    await tagList(session, 'ecr', repository.repositoryArn),
    run
  )
  await session.aws(['ecr', 'delete-repository', '--repository-name', name, '--force'], {
    allowMissing: true,
    dryResult: {},
  })
}

async function deleteBudget (session, { name, run, account }) {
  const reply = await session.aws(
    ['budgets', 'describe-budget', '--account-id', account, '--budget-name', name],
    { allowMissing: true }
  )
  if (!reply) return
  const budgetArn = `arn:aws:budgets::${account}:budget/${name}`
  assertTagged(session, 'budget', name, await tagList(session, 'budgets', budgetArn), run)
  await session.aws(
    ['budgets', 'delete-budget', '--account-id', account, '--budget-name', name],
    { allowMissing: true, dryResult: {} }
  )
}


// --- shared helpers ----------------------------------------------------------

async function tagList (session, service, arn) {
  const reply = await session.aws(
    [service, 'list-tags-for-resource', '--resource-arn', arn],
    { allowMissing: true }
  )
  return normalizeTags(responseTags(reply))
}

function responseTags (reply) {
  if (!reply) return []
  if (Array.isArray(reply.tags)) return reply.tags
  if (Array.isArray(reply.Tags)) return reply.Tags
  if (Array.isArray(reply.ResourceTags)) return reply.ResourceTags
  if (reply.tags && typeof reply.tags === 'object') {
    return Object.entries(reply.tags).map(([key, value]) => ({ key, value }))
  }
  return []
}

function normalizeTags (tags) {
  if (Array.isArray(tags)) {
    return tags.map((tag) => ({
      key: tag.key ?? tag.Key,
      value: tag.value ?? tag.Value,
    }))
  }
  if (tags && typeof tags === 'object') {
    return Object.entries(tags).map(([key, value]) => ({ key, value }))
  }
  return []
}

function hasRunTag (tags, run) {
  return normalizeTags(tags).some((tag) => tag.key === TAG_KEY && tag.value === run)
}

function assertTagged (_session, kind, name, tags, run) {
  if (hasRunTag(tags, run)) return
  throw new Error(
    scrub(`${kind} ${name} exists without tag ${TAG_KEY}=${run}; refusing to reuse or delete it`)
  )
}


function shortTaskArn (arn) {
  return String(arn || '').split('/').pop()
}

function shortTaskDefinitionArn (arn) {
  const parts = String(arn || '').split('/')
  return parts[parts.length - 1]
}

async function awsPages (session, args, key) {
  const items = []
  let token = null
  do {
    const pageArgs = token ? [...args, '--next-token', token] : args
    const page = await session.aws(pageArgs, {})
    if (Array.isArray(page?.[key])) items.push(...page[key])
    token = page?.nextToken || page?.NextToken || null
    if (session.dry) break
  } while (token)
  return items
}

async function waitUntil (session, label, timeoutMs, check) {
  const end = Date.now() + Math.max(timeoutMs, 1000)
  for (;;) {
    if (await check()) return true
    if (Date.now() >= end) {
      session.say(`wait: timed out on ${label}`)
      return false
    }
    await sleep(2000)
  }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function secretsOf (ctx) {
  // A dry run stores readable placeholders in state; they are not secrets and must
  // stay visible in the rendered task definitions.
  if (isDry(ctx.opts)) return []
  const state = ctx.state || {}
  return [state.scraperSeed, state.scraperSecret].filter(
    (secret) => typeof secret === 'string' && secret.length >= 8
  )
}

function scrub (text, secrets = []) {
  let value = String(text ?? '')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) {
      value = value.split(secret).join('<redacted>')
    }
  }
  value = value.split(REPO_ROOT).join('.')
  const home = homedir()
  if (home && home !== '/') value = value.split(home).join('~')
  value = value.replace(/\b\d{12}\b/g, 'ACCOUNT')
  value = value.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
  value = value.replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '<access-key>')
  return value
}

function quote (value) {
  const text = String(value)
  if (/^[A-Za-z0-9_/.:@%+=,-]+$/.test(text)) return text
  return `'${text.split("'").join("'\\''")}'`
}


function isMissing (text) {
  return /\b(?:RepositoryNotFoundException|ImageNotFoundException|ResourceNotFoundException|NoSuchEntity(?:Exception)?|NotFoundException|ClusterNotFoundException|InvalidGroup\.NotFound)\b/.test(text)
}

function argOf (args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null
}

// Canned answers for a dry run. They describe a fresh account: describe calls that
// would create a resource answer "not found", and every create call answers with a
// harmless placeholder. Nothing here is valid for a real registration.
function dryAwsReply (service, operation, args, options = {}) {
  const region = options.region || 'us-east-2'
  const run = options.run || 'RUN'
  const tag = [{ key: TAG_KEY, value: run }]

  if (service === 'sts' && operation === 'get-caller-identity') {
    return {
      UserId: 'AIDAEXAMPLE',
      Account: 'ACCOUNT',
      Arn: 'arn:aws:iam::ACCOUNT:user/operator',
    }
  }
  if (service === 'ecr' && operation === 'get-login-password') {
    return 'DRY_RUN_PASSWORD'
  }
  if (service === 'ecr' && operation === 'describe-repositories') {
    return { repositories: [] }
  }
  if (service === 'ecr' && operation === 'create-repository') {
    const name = argOf(args, '--repository-name') || 'repository'
    return {
      repository: {
        repositoryName: name,
        repositoryArn: `arn:aws:ecr:${region}:ACCOUNT:repository/${name}`,
        repositoryUri: `ACCOUNT.dkr.ecr.${region}.amazonaws.com/${name}`,
      },
    }
  }
  if (service === 'ecr' && operation === 'describe-images') {
    throw new Error('ImageNotFoundException')
  }
  if (service === 'iam' && operation === 'get-role') {
    throw new Error('dry run: NoSuchEntity')
  }
  if (service === 'iam' && operation === 'create-role') {
    const name = argOf(args, '--role-name') || 'role'
    return { Role: { RoleName: name, Arn: `arn:aws:iam::ACCOUNT:role/${name}` } }
  }
  if (service === 'iam' && operation === 'list-attached-role-policies') {
    return { AttachedPolicies: [] }
  }
  if (service === 'iam' && operation === 'list-role-policies') {
    return { PolicyNames: [] }
  }
  if (service === 'iam' && operation === 'list-role-tags') {
    return { Tags: tag }
  }
  if (service === 'logs' && operation === 'describe-log-groups') {
    return { logGroups: [] }
  }
  if (service === 'logs' && operation === 'list-tags-for-resource') {
    return { tags: { [TAG_KEY]: run } }
  }
  if (service === 'ec2' && operation === 'describe-vpcs') {
    return { Vpcs: [{ VpcId: 'vpc-PLACEHOLDER', IsDefault: true }] }
  }
  if (service === 'ec2' && operation === 'describe-subnets') {
    return {
      Subnets: [
        { SubnetId: 'subnet-PLACEHOLDER-1', AvailabilityZone: 'us-east-2a', MapPublicIpOnLaunch: true },
        { SubnetId: 'subnet-PLACEHOLDER-2', AvailabilityZone: 'us-east-2b', MapPublicIpOnLaunch: true },
        { SubnetId: 'subnet-PLACEHOLDER-3', AvailabilityZone: 'us-east-2c', MapPublicIpOnLaunch: true },
      ],
    }
  }
  if (service === 'ec2' && operation === 'describe-route-tables') {
    return { RouteTables: [] }
  }
  if (service === 'ec2' && operation === 'describe-security-groups') {
    return { SecurityGroups: [] }
  }
  if (service === 'ec2' && operation === 'create-security-group') {
    return { GroupId: 'sg-PLACEHOLDER' }
  }
  if (service === 'ec2' && operation === 'describe-network-interfaces') {
    return { NetworkInterfaces: [] }
  }
  if (service === 'ecs' && operation === 'describe-clusters') {
    return { clusters: [], failures: [] }
  }
  if (service === 'ecs' && operation === 'create-cluster') {
    const name = argOf(args, '--cluster-name') || 'cluster'
    return {
      cluster: {
        clusterName: name,
        clusterArn: `arn:aws:ecs:${region}:ACCOUNT:cluster/${name}`,
        status: 'ACTIVE',
      },
    }
  }
  if (service === 'ecs' && operation === 'list-task-definitions') {
    return { taskDefinitionArns: [] }
  }
  if (service === 'ecs' && operation === 'list-tasks') {
    return { taskArns: [] }
  }
  if (service === 'ecs' && operation === 'describe-tasks') {
    return { tasks: [] }
  }
  if (service === 'ecs' && operation === 'list-tags-for-resource') {
    return { tags: tag }
  }
  if (service === 'ecs' && operation === 'describe-task-definition') {
    return { taskDefinition: { status: 'ACTIVE' } }
  }
  if (service === 'budgets' && operation === 'describe-budget') {
    throw new Error('dry run: NotFoundException')
  }
  if (service === 'budgets' && operation === 'list-tags-for-resource') {
    return { ResourceTags: tag }
  }
  if (service === 'ecr' && operation === 'list-tags-for-resource') {
    return { tags: tag }
  }
  return {}
}
