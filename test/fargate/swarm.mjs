#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { aws, up, down, check, decodeZ32, taskAddresses, persistRunState, blindPeerLogKey } from './lib/aws.mjs'
import { CAPS, limitsMarkdown } from './lib/cost.mjs'
import { writeReport } from './lib/report.mjs'
import { prepare } from './lib/subset.mjs'
import { sampleHome } from './lib/home.mjs'
import { scrapeTargets, scrubArtifact } from './lib/scrape.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'peartube-fargate')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const steps = [1, 5, 20]
const additions = {
  1: { 'pt-direct': 1 },
  5: { 'pt-relayed': 1, bp: 1, br: 1, rp: 1 },
  20: { 'pt-direct': 5, 'pt-relayed': 3, bp: 4, br: 2, rp: 1 }
}
const kinds = { 'pt-direct': 'peartube', 'pt-relayed': 'peartube', bp: 'blind-peer', br: 'blind-relay', rp: 'relayed-peer' }
const short = value => String(value || '').split('/').pop().slice(0, 8)
const help = `Usage: node test/fargate/swarm.mjs <command> [options]

Commands:
  prepare --relay-api URL [--relay-api URL]   Select the subset and sample home relays
  up --owner-pub HEX --budget-email ADDRESS   Prepare AWS resources and images
  limits [--step-minutes 45,40,40]            Print the cost and safety limits
  scraper                                     Run the DHT Prometheus bridge
  step 1|5|20 [--max-minutes N]              Launch the next step
  watch [--interval 20]                       Watch progress and stop at limits
  stop                                        Stop all tasks in the run cluster
  collect                                     Collect scrubbed logs and tasks
  report [--from DIRECTORY]                   Write the five report sections
  down                                        Stop and remove run resources
  check                                       Check for remaining resources

Common: --run ID (default: newest), --arch arm64|amd64, --help
Up: --dry-run, --pt-image IMAGE; step: --force
Home monitoring requires PT_HOME_RELAYS (comma-separated) during watch.
`

function options (args) {
  const result = { _: [], relayApi: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) { result._.push(arg); continue }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (!['help', 'dryRun', 'force', 'run', 'relayApi', 'arch', 'ownerPub', 'budgetEmail', 'ptImage', 'stepMinutes', 'maxMinutes', 'interval', 'from'].includes(key)) throw new Error(`Unknown option: ${arg}`)
    if (['help', 'dryRun', 'force'].includes(key)) { result[key] = true; continue }
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`)
    const value = args[++i]
    if (key === 'relayApi') result.relayApi.push(value)
    else result[key] = value
  }
  return result
}

async function newestRun () {
  let names
  try { names = await readdir(cache) } catch (err) { if (err.code === 'ENOENT') return null; throw err }
  const runs = []
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]{0,28}$/.test(name)) continue
    try { runs.push({ name, time: (await stat(join(cache, name, 'run.json'))).mtimeMs }) } catch (err) { if (err.code !== 'ENOENT') throw err }
  }
  return runs.sort ( (a, b) => b.time - a.time )[0]?.name || null
}

async function context (opts, command) {
  const run = opts.run || await newestRun() || (command === 'prepare' ? `r${Date.now().toString(36)}` : null)
  if (!run || !/^[a-z0-9][a-z0-9-]{0,28}$/.test(run)) throw new Error('Set --run to a valid run id, or prepare a run first')
  const runDir = join(cache, run)
  const resultsDir = join(root, 'results', run)
  let state
  try { state = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) } catch (err) {
    if (err.code !== 'ENOENT') throw err
    state = { run, tasks: [], steps: {} }
  }
  if (state.run !== run) throw new Error('Run state does not match the requested run')
  state.tasks ||= []
  state.steps ||= {}
  const save = () => persistRunState(state, runDir)
  let subset = null
  try { subset = JSON.parse(await readFile(join(root, 'subset.json'), 'utf8')) } catch (err) { if (err.code !== 'ENOENT') throw err }
  if (state.subset) subset = state.subset
  const ctx = { run, runDir, resultsDir, opts, state, save, subset }
  ctx.stop = () => stop(ctx)
  return ctx
}

function minutes (value) {
  const values = String(value || '45,40,40').split(',').map(Number)
  if (values.length !== 3 || values.some(n => !Number.isFinite(n) || n <= 0)) throw new Error('Step minutes must be three positive numbers')
  return values
}

const safeText = input => scrubArtifact(String(input))

async function taggedCluster (ctx) {
  const name = ctx.state.cluster || `peartube-fargate-swarm-${ctx.run}`
  const response = await aws(['ecs', 'describe-clusters', '--clusters', name, '--include', 'TAGS'])
  const cluster = response.clusters?.find(c => c.clusterName === name && c.status !== 'INACTIVE')
  if (!cluster) return null
  if (!cluster.tags?.some(t => t.key === 'peartube-fargate-swarm' && t.value === ctx.run)) throw new Error('Cluster has no matching run tag; refusing to stop tasks')
  return name
}

async function stop (ctx) {
  const cluster = await taggedCluster(ctx)
  if (!cluster) return
  const requested = new Set()
  for (let pass = 0; pass < 120; pass++) {
    const lists = await Promise.all(['RUNNING', 'PENDING'].map(status => aws(['ecs', 'list-tasks', '--cluster', cluster, '--desired-status', status])))
    const tasks = [...new Set(lists.flatMap(x => x.taskArns || []))]
    const newTasks = tasks.filter(task => !requested.has(task))
    if (newTasks.length) {
      const info = await aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...newTasks, '--include', 'TAGS'])
      if (info.failures?.length || info.tasks?.length !== newTasks.length) throw new Error('Cannot verify task ownership')
      if (info.tasks.some(t => !t.tags?.some(tag => tag.key === 'peartube-fargate-swarm' && tag.value === ctx.run))) throw new Error('An untagged task was left untouched')
      for (const task of info.tasks) { await aws(['ecs', 'stop-task', '--cluster', cluster, '--task', task.taskArn, '--reason', 'Fargate swarm safety stop']); requested.add(task.taskArn) }
    }
    const observed = requested.size ? await aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...requested]) : { tasks: [] }
    if (observed.failures?.length || observed.tasks?.length !== requested.size) throw new Error('Cannot verify that stopped tasks have exited')
    if (!tasks.length && observed.tasks.every(task => task.lastStatus === 'STOPPED')) { console.log('All run tasks are stopped.'); return }
    await wait(1000)
  }
  throw new Error('Tasks did not stop within 120 seconds')
}

async function describe (ctx) {
  if (!ctx.state.tasks.length) return []
  const cluster = ctx.state.cluster || `peartube-fargate-swarm-${ctx.run}`
  const out = []
  for (let i = 0; i < ctx.state.tasks.length; i += 100) {
    const ids = ctx.state.tasks.slice(i, i + 100).map(t => t.taskArn)
    const result = await aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...ids])
    if (result.failures?.length) throw new Error('ECS could not describe every run task')
    out.push(...(result.tasks || []))
  }
  return out
}


async function events (ctx, start = 0) {
  const group = `/peartube-fargate-swarm/${ctx.run}`
  const found = []
  let token
  do {
    const args = ['logs', 'filter-log-events', '--log-group-name', group, '--start-time', String(Math.max(0, start)), '--no-paginate']
    if (token) args.push('--next-token', token)
    const result = await aws(args)
    found.push(...(result.events || []))
    if (!result.nextToken || result.nextToken === token) break
    token = result.nextToken
  } while (true)
  return found
}

function readEvent (event) {
  try { const value = JSON.parse(event.message); if (value && typeof value === 'object' && ['sample', 'event', 'owner'].includes(value.type)) return value } catch {}
  return { type: 'raw', stream: event.logStreamName || '', message: event.message || '' }
}

async function relayKeys (ctx, relays) {
  const deadline = Date.now() + 240000
  const keys = { ...(ctx.state.relayKeys || {}) }
  while (Date.now() < deadline) {
    for (const e of await events(ctx, Date.now() - 300000)) {
      const task = relays.find(t => (e.logStreamName || '').includes(short(t.taskArn)))
      const match = /Server listening on\s+([a-z0-9]+)/i.exec(e.message || '')
      if (task && match) keys[short(task.taskArn)] = /^[0-9a-f]{64}$/i.test(match[1]) ? match[1].toLowerCase() : decodeZ32(match[1])
    }
    ctx.state.relayKeys = keys
    await ctx.save()
    if (relays.every(t => keys[short(t.taskArn)])) return Object.values(keys)
    await wait(5000)
  }
  throw new Error('A blind relay did not publish its key within four minutes')
}

async function launchRole (ctx, step, role, count, keys) {
  if (!count) return []
  const left = Math.max(1, Math.ceil((Date.parse(ctx.state.deadlineAt) - Date.now()) / 60000))
  const remainingSec = Math.max(1, Math.ceil((Date.parse(ctx.state.deadlineAt) - Date.now()) / 1000))
  const probeEnv = [{ name: 'ROLE', value: role }, { name: 'RELAY_KEYS', value: keys.join(',') }, { name: 'DEADLINE_MIN', value: String(left) }]
  const overrides = [{ name: 'probe', environment: probeEnv }]
  if (role === 'pt-relayed') overrides.push({ name: 'peartube', environment: [{ name: 'PEARTUBE_RELAY_THROUGH', value: keys.join(',') }] })
  if (role === 'br') overrides.push({ name: 'blind-relay', environment: [{ name: 'BR_TIMEOUT_SEC', value: String(remainingSec) }] })
  if (role === 'bp') overrides.push({ name: 'blind-peer', command: ['--trusted-peer', ctx.state.ownerPub, '--active-corestore', '--max-storage', '15000', '--auto-shutdown-minutes', String(left + 30), '--scraper-public-key', ctx.state.scraperPublicKey, '--scraper-secret', ctx.state.scraperSecret] })
  const family = role === 'pt-relayed' ? 'peartube-relayed' : kinds[role]
  const common = ['ecs', 'run-task', '--cluster', ctx.state.cluster, '--task-definition', ctx.state.taskDefinitions[family], '--network-configuration', JSON.stringify({ awsvpcConfiguration: { subnets: ctx.state.subnets, securityGroups: [ctx.state.securityGroup], assignPublicIp: 'ENABLED' } }), '--overrides', JSON.stringify({ containerOverrides: overrides }), '--tags', JSON.stringify([{ key: 'peartube-fargate-swarm', value: ctx.run }])]
  const launchedAt = new Date().toISOString()
  const record = (result, capacity) => {
    const launched = (result.tasks || []).map(t => ({ taskArn: t.taskArn, kind: kinds[role], role, step, launchedAt, capacity }))
    for (const task of launched) if (!ctx.state.tasks.some(t => t.taskArn === task.taskArn)) ctx.state.tasks.push(task)
    return launched
  }
  const result = await aws([...common, '--launch-type', 'FARGATE', '--count', String(count), '--client-token', `${ctx.run}-${step}-${role}`], { secrets: [ctx.state.scraperSecret] })
  let launched = record(result, 'on-demand')
  await ctx.save()
  const failures = result.failures || []
  // The account's Fargate On-Demand vCPU quota is 4; what does not fit goes to Fargate Spot and is marked so.
  const quotaHit = failures.some(f => /vCPU|limit|capacity/i.test(f.reason || ''))
  if (quotaHit && launched.length < count) {
    const missing = count - launched.length
    console.log(`On-Demand vCPU quota reached for ${role}: launching ${missing} on Fargate Spot.`)
    await aws(['ecs', 'put-cluster-capacity-providers', '--cluster', ctx.state.cluster, '--capacity-providers', 'FARGATE', 'FARGATE_SPOT', '--default-capacity-provider-strategy', 'capacityProvider=FARGATE,weight=1'])
    const spot = await aws([...common, '--capacity-provider-strategy', 'capacityProvider=FARGATE_SPOT,weight=1', '--count', String(missing), '--client-token', `${ctx.run}-${step}-${role}-spot`], { secrets: [ctx.state.scraperSecret] })
    launched = launched.concat(record(spot, 'spot'))
    await ctx.save()
    if (spot.failures?.length) console.log(`Spot launch failures: ${JSON.stringify(spot.failures.map(f => f.reason))}`)
  } else if (failures.length) {
    console.log(`Launch failures for ${role}: ${JSON.stringify(failures.map(f => f.reason))}`)
  }
  if (launched.length !== count) throw new Error(`ECS launched ${launched.length} of ${count} ${role} tasks`)
  console.log(`Launched ${launched.length} ${role} task(s).`)
  return launched
}

async function step (ctx) {
  const n = Number(ctx.opts._[1])
  const index = steps.indexOf(n)
  if (index < 0) throw new Error('Step must be 1, 5, or 20')
  if (!ctx.state.taskDefinitions || !ctx.subset) throw new Error('Prepare and bring up this run first')
  if (index && !ctx.state.steps[steps[index - 1]]?.gatePassed) {
    if (!ctx.opts.force) throw new Error(`Step ${steps[index - 1]} has not passed its gate`)
    console.warn('WARNING: forcing a step without the previous gate')
  }
  const durations = minutes(ctx.opts.stepMinutes || ctx.state.stepMinutes)
  const maxMinutes = Number(ctx.opts.maxMinutes || durations[index])
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error('max-minutes must be positive')
  if (!ctx.state.deadlineAt) {
    if (n !== 1) throw new Error('Step 1 must set the run deadline first')
    ctx.state.deadlineAt = new Date(Date.now() + (durations.reduce((a, b) => a + b, 0) + 15) * 60000).toISOString()
  }
  if (Date.now() >= Date.parse(ctx.state.deadlineAt)) throw new Error('The run deadline has passed')
  ctx.state.stepMinutes = durations
  ctx.state.currentStep = n
  ctx.state.steps[n] ||= { startedAt: new Date().toISOString(), maxMinutes, gatePassed: false }
  await ctx.save()
  try {
    const mix = additions[n]
    const existing = role => ctx.state.tasks.filter(t => t.step === n && t.role === role).length
    await launchRole(ctx, n, 'br', Math.max(0, (mix.br || 0) - existing('br')), [])
    const relays = ctx.state.tasks.filter(t => t.role === 'br')
    const keys = relays.length ? await relayKeys(ctx, relays) : []
    for (const role of ['pt-direct', 'pt-relayed', 'bp', 'rp']) await launchRole(ctx, n, role, Math.max(0, (mix[role] || 0) - existing(role)), keys)
  } catch (err) { await stop(ctx); throw err }
}

async function ownerLines (ctx) {
  try { return (await readFile(join(ctx.resultsDir, 'owner.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch (err) { if (err.code === 'ENOENT') return []; throw err }
}

function gate (ctx, latest, owners) {
  const relevant = ctx.state.tasks.filter(t => t.step <= ctx.state.currentStep && (t.kind === 'peartube' || t.kind === 'blind-peer'))
  const problems = [], completed = new Set()
  for (const task of relevant) {
    if (task.lastStatus !== 'RUNNING') problems.push(`${short(task.taskArn)} is not running`)
    const sample = latest.get(short(task.taskArn))
    if (!sample) { problems.push(`${short(task.taskArn)} has no sample`); continue }
    if (task.kind === 'peartube') {
      const rep = sample.pt?.rep
      if (!rep || rep.skippedDiskFull !== 0 || !(rep.targetBytes >= ctx.subset.totalBytes && rep.replicatedBytes >= rep.targetBytes && rep.replicatedEntries >= rep.totalEntries && rep.totalEntries > 0)) problems.push(`${short(task.taskArn)} has not completed the subset or skipped a full disk`); else completed.add(short(task.taskArn))
    } else {
      let key = sample.bp?.key || task.publicKey || ''
      if (key && !/^[0-9a-f]{64}$/i.test(key)) { try { key = decodeZ32(key) } catch { key = '' } }
      const owner = owners.filter(o => o.bp?.toLowerCase() === key.toLowerCase() && o.cores).sort((a, b) => b.ts - a.ts)[0]
      if (!owner || !ctx.subset.entries.every(entry => { const core = owner.cores[entry.blobs.slice(0, 8)]; return core?.length > 0 && (core.remoteContiguousLength ?? core.remoteContiguous ?? 0) >= core.length })) problems.push(`${short(task.taskArn)} lacks owner-confirmed complete cores`); else completed.add(short(task.taskArn))
    }
    if ((sample.pt?.rep?.skippedDiskFull || 0) > 0) problems.push(`${short(task.taskArn)} skipped a full disk`)
  }
  return { passed: relevant.length > 0 && problems.length === 0, problems, completed }
}

async function watch (ctx) {
  if (!ctx.state.currentStep || !ctx.state.deadlineAt) throw new Error('Start a step first')
  const urls = (process.env.PT_HOME_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!urls.length) { await stop(ctx); throw new Error('Set PT_HOME_RELAYS for the home-relay safety guard') }
  const interval = Number(ctx.opts.interval || 20)
  if (!Number.isFinite(interval) || interval <= 0) { await stop(ctx); throw new Error('interval must be positive') }
  const latest = new Map(), first = new Set(), full = new Set(), seen = new Set(), slow = new Map()
  let since = 0, observedLogBytes = 0, interrupted = false
  const interrupt = () => { interrupted = true }
  process.on('SIGINT', interrupt)
  try {
    while (!interrupted) {
      Object.assign(ctx.state, JSON.parse(await readFile(join(ctx.runDir, 'run.json'), 'utf8')))
      const current = await describe(ctx)
      const addresses = await taskAddresses(current)
      for (const t of current) { const saved = ctx.state.tasks.find(x => x.taskArn === t.taskArn); if (saved) { saved.startedAt = t.startedAt || saved.startedAt; saved.stoppedAt = t.stoppedAt || saved.stoppedAt; saved.lastStatus = t.lastStatus; saved.publicIp = addresses.get(t.taskArn) || saved.publicIp } }
      for (const raw of await events(ctx, Math.max(0, since - 60000))) {
        if (seen.has(raw.eventId)) continue
        if (raw.eventId) seen.add(raw.eventId)
        observedLogBytes += Buffer.byteLength(raw.message || '', 'utf8') + 26
        since = Math.max(since, raw.timestamp || 0)
        const peerKey = blindPeerLogKey(raw)
        if (peerKey) { const task = ctx.state.tasks.find(t => t.kind === 'blind-peer' && short(t.taskArn) === peerKey.task); if (task && task.publicKey !== peerKey.key) { task.publicKey = peerKey.key; console.log(`Blind peer ${peerKey.task}: ${peerKey.key}`) } }
        const e = readEvent(raw)
        if (e.type === 'sample' && e.task && (!latest.has(e.task) || latest.get(e.task).ts < e.ts)) latest.set(e.task, e)
        if (e.type === 'event' && e.ev === 'first-byte') first.add(e.task)
        if (e.type === 'event' && e.ev === 'full-copy') full.add(e.task)
      }
      const needsScraper = ctx.state.tasks.some(t => t.kind === 'blind-peer' || t.kind === 'blind-relay')
      let scrapes = []
      if (needsScraper) {
        try { scrapes = await scrapeTargets({ run: ctx.run, runDir: ctx.runDir, resultsDir: ctx.resultsDir, port: Number(process.env.SCRAPER_PORT || 9352) }) } catch (err) {
          if (Date.now() - Date.parse(ctx.state.steps[ctx.state.currentStep].startedAt) > 240000) throw err
          console.warn('Waiting for scraper targets.')
        }
      }
      const homes = await sampleHome({ urls, resultsDir: ctx.resultsDir })
      for (const h of homes) slow.set(h.relay, !h.ok || h.ms > 2000 ? (slow.get(h.relay) || 0) + 1 : 0)
      const group = await aws(['logs', 'describe-log-groups', '--log-group-name-prefix', `/peartube-fargate-swarm/${ctx.run}`])
      const storedBytes = group.logGroups?.find(g => g.logGroupName === `/peartube-fargate-swarm/${ctx.run}`)?.storedBytes
      if (!Number.isFinite(storedBytes)) throw new Error('CloudWatch log size is unavailable')
      const logBytes = Math.max(storedBytes, observedLogBytes, ctx.state.logBytes || 0)
      ctx.state.logBytes = logBytes
      const now = Date.now()
      const taskHours = ctx.state.tasks.reduce((sum, t) => sum + (t.startedAt ? Math.max(0, (t.stoppedAt ? Date.parse(t.stoppedAt) : now) - Date.parse(t.startedAt)) / 3600000 : 0), 0)
      const tx = [...latest.values()].reduce((sum, s) => sum + (Number(s.ecs?.tx) || 0), 0)
      const verdict = gate(ctx, latest, await ownerLines(ctx))
      ctx.state.steps[ctx.state.currentStep].gatePassed = verdict.passed
      await ctx.save()
      console.log('\nKind | running | first byte | full copy | replicated bytes (blind peer: store bytes) | skipped disk full | relayed connections')
      for (const kind of ['peartube', 'blind-peer', 'blind-relay', 'relayed-peer']) {
        const tasks = ctx.state.tasks.filter(t => t.kind === kind)
        const samples = tasks.map(t => latest.get(short(t.taskArn))).filter(Boolean)
        console.log(`${kind} | ${tasks.filter(t => t.lastStatus === 'RUNNING').length} | ${tasks.filter(t => first.has(short(t.taskArn))).length} | ${tasks.filter(t => full.has(short(t.taskArn)) || verdict.completed.has(short(t.taskArn))).length} | ${samples.reduce((n, s) => n + (s.pt?.rep?.replicatedBytes || s.rp?.haveBytes || s.bp?.storeBytes || 0), 0)} | ${samples.reduce((n, s) => n + (s.pt?.rep?.skippedDiskFull || 0), 0)} | ${samples.reduce((n, s) => n + (s.rp?.conns || []).filter(c => c.ok).length, 0)}`)
      }
      const relayMetrics = scrapes.filter(s => s.metrics?.blind_relay_pairings_active !== undefined)
      console.log(`Blind relays: ${relayMetrics.length}; pairings requested/matched/active: ${['requested', 'matched', 'active'].map(k => relayMetrics.reduce((n, s) => n + (Number(s.metrics['blind_relay_pairings_' + k]) || 0), 0)).join('/')}; streams opened/closed/errors: ${['opened', 'closed', 'errors'].map(k => relayMetrics.reduce((n, s) => n + (Number(s.metrics['blind_relay_streams_' + k]) || 0), 0)).join('/')}`)
      console.log(`Limits: task-hours ${(taskHours / CAPS.hours * 100).toFixed(1)}%, sent ${(tx / CAPS.txBytes * 100).toFixed(1)}%, logs ${(logBytes / CAPS.logBytes * 100).toFixed(1)}%. Gate: ${verdict.passed ? 'PASS' : 'WAIT ' + verdict.problems.join('; ')}`)
      const stepState = ctx.state.steps[ctx.state.currentStep]
      let reason = taskHours >= CAPS.hours * CAPS.trip ? 'task-hours reached 80%' : tx >= CAPS.txBytes * CAPS.trip ? 'sent bytes reached 80%' : logBytes >= CAPS.logBytes * CAPS.trip ? 'log bytes reached 80%' : null
      if (!reason && now >= Date.parse(ctx.state.deadlineAt)) reason = 'run deadline reached'
      if (!reason && [...slow.values()].some(n => n >= 3)) reason = 'home relay was slow or unavailable for three polls'
      if (!reason && now >= Date.parse(stepState.startedAt) + stepState.maxMinutes * 60000) reason = 'step time limit reached'
      if (!reason && ctx.state.tasks.some(t => { const s = latest.get(short(t.taskArn)); return t.lastStatus === 'RUNNING' && t.startedAt && now - Date.parse(t.startedAt) > 120000 && (!Number.isFinite(s?.ecs?.tx) || s.ecs.tx < 0 || !Number.isFinite(s.ts) || now - s.ts > 120000) })) reason = 'a running task has missing or stale network counters'
      if (reason) { console.log(`Stopping: ${reason}.`); await stop(ctx); return }
      await wait(interval * 1000)
    }
  } catch (err) { console.error(`Stopping because monitoring failed: ${safeText(err.message)}`); await stop(ctx); throw err } finally { process.removeListener('SIGINT', interrupt) }
}

async function collect (ctx) {
  const described = await describe(ctx)
  const ips = await taskAddresses(described)
  const taskIps = new Set([...ips.values(), ...ctx.state.tasks.map(t => t.publicIp)].filter(Boolean))
  const tasks = ctx.state.tasks.map(saved => {
    const t = described.find(x => x.taskArn === saved.taskArn) || {}
    const publicIp = ips.get(saved.taskArn) || saved.publicIp || null
    const image = t.containers?.find(c => c.name !== 'probe')?.image || t.containers?.[0]?.image || null
    return scrubArtifact({ task: short(saved.taskArn), kind: saved.kind, role: saved.role, step: saved.step, launchedAt: saved.launchedAt, startedAt: t.startedAt || saved.startedAt || null, stoppedAt: t.stoppedAt || saved.stoppedAt || null, stopCode: t.stopCode || null, publicIp, vcpu: Number(t.cpu || 0) / 1024 || null, memMiB: Number(t.memory || 0) || null, image }, taskIps)
  })
  const rawEvents = await events(ctx)
  const groups = await aws(['logs', 'describe-log-groups', '--log-group-name-prefix', `/peartube-fargate-swarm/${ctx.run}`])
  const stored = groups.logGroups?.find(group => group.logGroupName === `/peartube-fargate-swarm/${ctx.run}`)?.storedBytes || 0
  ctx.state.logBytes = Math.max(ctx.state.logBytes || 0, stored, rawEvents.reduce((n, event) => n + Buffer.byteLength(event.message || '', 'utf8') + 26, 0))
  await ctx.save()
  const rows = rawEvents.map(raw => scrubArtifact(readEvent(raw), taskIps))
  await mkdir(ctx.resultsDir, { recursive: true })
  await writeFile(join(ctx.resultsDir, 'tasks.json'), JSON.stringify(tasks, null, 2) + '\n')
  await writeFile(join(ctx.resultsDir, 'events.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''))
  console.log(`Collected ${tasks.length} tasks and ${rows.length} log events.`)
}

async function scraper (ctx) {
  if (!ctx.state.scraperSeed || !ctx.state.scraperSecret) throw new Error('Bring up this run before starting the scraper')
  const executable = join(root, 'owner', 'node_modules', 'dht-prometheus', 'run.js')
  try { await stat(executable) } catch (err) { if (err.code === 'ENOENT') throw new Error('Install dht-prometheus@2.0.0 in test/fargate/owner before starting the scraper'); throw err }
  await mkdir(ctx.runDir, { recursive: true, mode: 0o700 })
  const env = { ...process.env, DHT_PROM_KEY_PAIR_SEED: ctx.state.scraperSeed, DHT_PROM_SHARED_SECRET: ctx.state.scraperSecret, DHT_PROM_HTTP_PORT: process.env.SCRAPER_PORT || '9352', DHT_PROM_HTTP_HOST: '127.0.0.1', DHT_PROM_PROMETHEUS_TARGETS_LOC: join(ctx.runDir, 'targets.json') }
  const child = spawn(process.execPath, [executable], { env, stdio: 'inherit' })
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => code === 0 || signal === 'SIGINT' ? resolve() : reject(new Error(`Scraper exited with ${code ?? signal}`))) })
}

async function main () {
  const opts = options(process.argv.slice(2))
  if (opts.help || !opts._.length) { console.log(help); return }
  const command = opts._[0]
  const ctx = await context(opts, command)
  switch (command) {
    case 'prepare':
      if (!opts.relayApi.length) throw new Error('At least one --relay-api is required')
      await mkdir(ctx.resultsDir, { recursive: true })
      ctx.subset = await prepare({ run: ctx.run, resultsDir: ctx.resultsDir, urls: opts.relayApi })
      ctx.state.subset = ctx.subset
      await ctx.save()
      console.log(`Prepared run ${ctx.run}.`)
      break
    case 'up': await up(ctx); break
    case 'limits': {
      const table = limitsMarkdown({ arch: opts.arch || ctx.state.arch || 'amd64', stepMinutes: minutes(opts.stepMinutes || ctx.state.stepMinutes) })
      await mkdir(ctx.resultsDir, { recursive: true })
      await writeFile(join(ctx.resultsDir, 'limits.md'), table + '\n')
      console.log(table)
      break
    }
    case 'scraper': await scraper(ctx); break
    case 'step': await step(ctx); break
    case 'watch': await watch(ctx); break
    case 'stop': await stop(ctx); break
    case 'collect': await collect(ctx); break
    case 'report': await writeReport({ run: ctx.run, from: opts.from || ctx.resultsDir, resultsDir: ctx.resultsDir, arch: opts.arch || ctx.state.arch || 'amd64', logBytes: opts.from ? null : ctx.state.logBytes ?? null, subsetBytes: ctx.subset?.totalBytes }); break
    case 'down': await down(ctx); break
    case 'check': if (!(await check(ctx))) process.exitCode = 1; break
    default: throw new Error(`Unknown command: ${command}`)
  }
}

main().catch(err => { console.error(`Error: ${safeText(err.message)}`); process.exitCode = 1 })
