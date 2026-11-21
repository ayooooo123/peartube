// Cost model for the Fargate swarm test.
//
// Prices are from the AWS Price List API for us-east-2, read 2026-11-21.
// Money is USD. Bytes are decimal: 1 GB = 1e9 bytes, as AWS bills network
// transfer and CloudWatch Logs ingestion.
//
// The test never reads AWS Billing. The measured side of this model uses only
// the run's own records: task start/stop times, the probe `start` event's vCPU
// and memory, and the ECS network counters in the probe samples.
//
// The published Fargate rates include the free 20 GiB of ephemeral storage per
// task. Storage above that is charged at PRICES.ephemeralStorage.gbHour.
//
// Cost shapes:
//   expected: measured task-hours and logs, with regional-only task traffic.
//   worst:    every hard cap reached, with the highest task compute rate and
//             every sent byte charged at both internet and regional rates.
//
// ECR storage is listed in PRICES but is not part of either total: image sizes
// are not part of the run's counters.

const GB = 1e9
const HOUR_MS = 3_600_000
const CEILING_USD = 10

export const PRICES = Object.freeze({
  region: 'us-east-2',
  pricedAt: '2026-11-21',
  fargate: Object.freeze({
    amd64: Object.freeze({ vcpuHour: 0.04048, gbHour: 0.004445 }),
    arm64: Object.freeze({ vcpuHour: 0.03238, gbHour: 0.00356 })
  }),
  ephemeralStorage: Object.freeze({ freeGb: 20, gbHour: 0.000111 }),
  ipv4Hour: 0.005,
  transfer: Object.freeze({
    // Outbound to the internet, and regional between public IPs
    // ($0.01/GB each direction). The model charges both on every tx byte.
    internetGb: 0.09,
    regionalGb: 0.02,
    txGb: 0.11
  }),
  logsGb: 0.50,
  ecrGbMonth: 0.10
})

export const CAPS = Object.freeze({
  hours: 30,          // total task-hours across the run
  txBytes: 60e9,      // 60 GB of task network tx: 17 storage peers x 2.43 GB is 41 GB if every byte is shared between tasks
  logBytes: 1e9,      // 1 GB of CloudWatch Logs ingested
  trip: 0.8           // watch stops the run at 80% of any cap
})

function mix (step, total, tasks) {
  return Object.freeze({
    step,
    total,
    tasks: Object.freeze(tasks.map(task => Object.freeze({ ...task })))
  })
}

// Cumulative task mix after each scale step. Tasks from earlier steps keep
// running, so a task's bill is its whole life, not one step's wall time.
// step 1: 1 peartube direct
// step 5: 1 each of the five cells
// step 20: 6 peartube direct, 4 peartube relayed, 5 blind-peer,
//          3 blind-relay, 2 relayed-peer
export const MIX = Object.freeze([
  mix(1, 1, [
    { kind: 'peartube', role: 'pt-direct', count: 1 }
  ]),
  mix(5, 5, [
    { kind: 'peartube', role: 'pt-direct', count: 1 },
    { kind: 'peartube', role: 'pt-relayed', count: 1 },
    { kind: 'blind-peer', role: 'bp', count: 1 },
    { kind: 'blind-relay', role: 'br', count: 1 },
    { kind: 'relayed-peer', role: 'rp', count: 1 }
  ]),
  mix(20, 20, [
    { kind: 'peartube', role: 'pt-direct', count: 6 },
    { kind: 'peartube', role: 'pt-relayed', count: 4 },
    { kind: 'blind-peer', role: 'bp', count: 5 },
    { kind: 'blind-relay', role: 'br', count: 3 },
    { kind: 'relayed-peer', role: 'rp', count: 2 }
  ])
])

// Fargate sizes used by the task definitions.
const SIZING = Object.freeze({
  peartube: Object.freeze({ vcpu: 0.25, memMiB: 1024, storageGiB: 20 }),
  'blind-peer': Object.freeze({ vcpu: 0.25, memMiB: 1024, storageGiB: 20 }),
  'blind-relay': Object.freeze({ vcpu: 0.25, memMiB: 512, storageGiB: 20 }),
  'relayed-peer': Object.freeze({ vcpu: 0.25, memMiB: 1024, storageGiB: 20 })
})

function ratesFor (arch) {
  const rates = PRICES.fargate[arch]
  if (!rates) {
    throw new Error('unknown arch "' + arch + '"; expected amd64 or arm64')
  }
  return rates
}

function sizingFor (kind) {
  const size = SIZING[kind]
  if (!size) {
    throw new Error('unknown task kind "' + kind + '"; expected one of ' +
      Object.keys(SIZING).join(', '))
  }
  return size
}

function computePerHourFor (kind, arch) {
  const rates = ratesFor(arch)
  const size = sizingFor(kind)
  return size.vcpu * rates.vcpuHour + (size.memMiB / 1024) * rates.gbHour
}

// USD per task-hour for one kind, including the public IPv4 address but
// excluding transfer, logs, ECR, and storage above the free allowance.
export function pricePerHour (kind, arch = 'amd64') {
  return computePerHourFor(kind, arch) + PRICES.ipv4Hour
}

function maximumComputePerHour (arch) {
  return Math.max(...Object.keys(SIZING).map(kind => computePerHourFor(kind, arch)))
}

function maximumSizing () {
  const sizes = Object.values(SIZING)
  return {
    vcpu: Math.max(...sizes.map(size => size.vcpu)),
    memGiB: Math.max(...sizes.map(size => size.memMiB / 1024))
  }
}

function stepPlan (stepMinutes, arch) {
  if (!Array.isArray(stepMinutes) || stepMinutes.length !== MIX.length) {
    throw new Error('stepMinutes must be an array of ' + MIX.length + ' positive numbers')
  }
  if (stepMinutes.some(minutes => !Number.isFinite(minutes) || minutes <= 0)) {
    throw new Error('stepMinutes must contain only positive numbers')
  }

  const previousByRole = new Map()
  let previousTotal = 0

  return MIX.map((entry, index) => {
    const remainingMinutes = stepMinutes.slice(index).reduce((sum, n) => sum + n, 0)
    const newTasks = entry.total - previousTotal
    if (newTasks < 0) throw new Error('MIX totals must not decrease')
    let newComputePerHour = 0
    const added = []

    for (const group of entry.tasks) {
      const key = group.kind + '/' + group.role
      const before = previousByRole.get(key) || 0
      const count = group.count - before
      if (count < 0) throw new Error('MIX count for ' + key + ' must not decrease')
      if (count > 0) {
        newComputePerHour += count * computePerHourFor(group.kind, arch)
        added.push({
          kind: group.kind,
          role: group.role,
          count,
          taskHours: count * remainingMinutes / 60,
          computeUsd: count * computePerHourFor(group.kind, arch) * remainingMinutes / 60
        })
      }
      previousByRole.set(key, group.count)
    }

    previousTotal = entry.total

    return {
      step: entry.step,
      total: entry.total,
      newTasks,
      minutes: stepMinutes[index],
      remainingMinutes,
      taskHours: newTasks * remainingMinutes / 60,
      computePerHour: newComputePerHour,
      computeUsd: newComputePerHour * remainingMinutes / 60,
      added
    }
  })
}

function money (value) {
  return Number.isFinite(value) ? '$' + value.toFixed(4) : 'n/a'
}

function hours (value) {
  return Number.isFinite(value) ? value.toFixed(2) : 'n/a'
}

// Markdown for `swarm.mjs limits`: the sizing, published prices, cumulative
// schedule, and the worst case at 80% of every cap. Deterministic; no I/O.
export function limitsMarkdown ({ arch = 'amd64', stepMinutes = [45, 40, 40] } = {}) {
  const rates = ratesFor(arch)
  const plan = stepPlan(stepMinutes, arch)
  const scheduledHours = plan.reduce((sum, step) => sum + step.taskHours, 0)
  const scheduledCompute = plan.reduce((sum, step) => sum + step.computeUsd, 0)
  const scheduledIpv4 = scheduledHours * PRICES.ipv4Hour

  const tripHours = CAPS.hours * CAPS.trip
  const averageComputePerHour = maximumComputePerHour(arch)
  const worstCompute = tripHours * averageComputePerHour
  const worstIpv4 = tripHours * PRICES.ipv4Hour
  const worstTx = CAPS.txBytes * CAPS.trip / GB * PRICES.transfer.txGb
  const worstLogs = CAPS.logBytes * CAPS.trip / GB * PRICES.logsGb
  const worstTotal = worstCompute + worstIpv4 + worstTx + worstLogs
  const ceiling = CEILING_USD

  const lines = []
  lines.push('# Fargate swarm test: limits')
  lines.push('')
  lines.push('Prices: AWS Price List API, ' + PRICES.region + ', read ' +
    PRICES.pricedAt + '. Money in USD; GB is decimal (1e9 bytes).')
  lines.push('')
  lines.push('## Prices')
  lines.push('')
  lines.push('| Item | Rate |')
  lines.push('|---|---:|')
  lines.push('| Fargate ' + arch + ' vCPU | $' + rates.vcpuHour.toFixed(5) + ' per vCPU-hour |')
  lines.push('| Fargate ' + arch + ' memory | $' + rates.gbHour.toFixed(6) + ' per GB-hour |')
  lines.push('| Ephemeral storage above ' + PRICES.ephemeralStorage.freeGb +
    ' GiB | $' + PRICES.ephemeralStorage.gbHour.toFixed(6) + ' per GB-hour |')
  lines.push('| Public IPv4 | $' + PRICES.ipv4Hour.toFixed(3) + ' per hour |')
  lines.push('| Internet data out | $' + PRICES.transfer.internetGb.toFixed(2) + ' per GB |')
  lines.push('| Regional data between public IPs | $' +
    PRICES.transfer.regionalGb.toFixed(2) + ' per GB on every tx byte |')
  lines.push('| CloudWatch Logs ingestion | $' + PRICES.logsGb.toFixed(2) + ' per GB |')
  lines.push('| ECR storage | $' + PRICES.ecrGbMonth.toFixed(2) + ' per GB-month |')
  lines.push('')
  lines.push('All task tx is charged $' + PRICES.transfer.txGb.toFixed(2) +
    '/GB: $' + PRICES.transfer.internetGb.toFixed(2) + '/GB internet plus $' +
    PRICES.transfer.regionalGb.toFixed(2) + '/GB regional.')
  lines.push('')
  lines.push('## Task sizing assumed by this table')
  lines.push('')
  lines.push('| Kind | vCPU | Memory | Storage | Compute + IPv4 per hour | Step 1 hours | Step 5 hours | Step 20 hours | Total hours |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const kind of Object.keys(SIZING)) {
    const size = SIZING[kind]
    const byStep = MIX.map((mix, index) => mix.tasks.filter(group => group.kind === kind).reduce((sum, group) => sum + group.count * stepMinutes[index] / 60, 0))
    lines.push('| ' + kind + ' | ' + size.vcpu.toFixed(2) + ' | ' +
      size.memMiB + ' MiB | ' + size.storageGiB + ' GiB | ' +
      money(pricePerHour(kind, arch)) + ' | ' + byStep.map(hours).join(' | ') + ' | ' + hours(byStep.reduce((a, b) => a + b, 0)) + ' |')
  }
  lines.push('')
  lines.push('The report prices a real run from its own vCPU, memory, start and stop records.')
  lines.push('')
  lines.push('## Cumulative schedule')
  lines.push('')
  lines.push('Every step adds tasks; tasks from earlier steps keep running. Wall minutes are ' +
    stepMinutes.join(' / ') + '.')
  lines.push('')
  lines.push('| Step | New tasks | Cumulative tasks | Wall minutes | Remaining minutes | Task-hours added | Compute + IPv4 added |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|')
  for (const step of plan) {
    lines.push('| ' + step.step + ' | ' + step.newTasks + ' | ' + step.total + ' | ' +
      step.minutes + ' | ' + step.remainingMinutes + ' | ' +
      hours(step.taskHours) + ' | ' +
      money(step.computeUsd + step.taskHours * PRICES.ipv4Hour) + ' |')
  }
  lines.push('| all | ' + plan.reduce((sum, step) => sum + step.newTasks, 0) + ' | ' +
    MIX[MIX.length - 1].total + ' | ' + stepMinutes.reduce((sum, n) => sum + n, 0) + ' | ' +
    'n/a: no later step | ' + hours(scheduledHours) + ' | ' +
    money(scheduledCompute + scheduledIpv4) + ' |')
  lines.push('')
  lines.push('At these wall minutes the run is ' + hours(scheduledHours) +
    ' task-hours. Compute + IPv4 at that schedule is ' +
    money(scheduledCompute + scheduledIpv4) + '; tx and logs are priced from their caps below.')
  lines.push('')
  lines.push('## Caps and the trip point')
  lines.push('')
  lines.push('`watch` stops every task when a counter reaches ' +
    (CAPS.trip * 100).toFixed(0) + '% of its cap.')
  lines.push('')
  lines.push('| Counter | Cap | 80% trip | Rate used | Cost at trip |')
  lines.push('|---|---:|---:|---:|---:|')
  lines.push('| Task-hours | ' + CAPS.hours + ' h | ' + tripHours.toFixed(1) +
    ' h | $' + averageComputePerHour.toFixed(6) + '/h highest compute | ' +
    money(worstCompute) + ' |')
  lines.push('| Public IPv4-hours | follows task-hours | ' + tripHours.toFixed(1) +
    ' h | $' + PRICES.ipv4Hour.toFixed(3) + '/h | ' + money(worstIpv4) + ' |')
  lines.push('| Task tx | ' + (CAPS.txBytes / GB) + ' GB | ' +
    (CAPS.txBytes * CAPS.trip / GB).toFixed(1) + ' GB | $' +
    PRICES.transfer.txGb.toFixed(2) + '/GB | ' + money(worstTx) + ' |')
  lines.push('| Logs ingested | ' + (CAPS.logBytes / GB) + ' GB | ' +
    (CAPS.logBytes * CAPS.trip / GB).toFixed(1) + ' GB | $' +
    PRICES.logsGb.toFixed(2) + '/GB | ' + money(worstLogs) + ' |')
  lines.push('| Ephemeral storage | 20 GiB free per task | n/a: no trip point | $' +
    PRICES.ephemeralStorage.gbHour.toFixed(6) + '/GB-hour | $0.0000 at this sizing |')
  lines.push('| ECR storage | n/a: no cap | n/a: no trip point | $' + PRICES.ecrGbMonth.toFixed(2) +
    '/GB-month | n/a: image sizes are not a run counter |')
  lines.push('| **Total** | n/a: not a counter | n/a: not a counter | n/a: not a counter | **' +
    money(worstTotal) + '** |')
  lines.push('')
  lines.push('Worst case at the trip point: ' + money(worstTotal) +
    (worstTotal < ceiling ? ' (under the $' + ceiling.toFixed(2) + ' default ceiling).'
      : ' (OVER the $' + ceiling.toFixed(2) + ' default ceiling).'))
  lines.push('At the full hard caps: ' + money(worstTotal / CAPS.trip) + ' before unmeasured ECR storage.')
  lines.push('The run\'s expected cost comes from its own counters, not from these caps.')
  lines.push('')
  return lines.join('\n')
}

function toNumber (value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function timeMs (value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return null
}

function asLines (value, name) {
  if (value == null) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    if (name === 'tasks') {
      try {
        const parsed = JSON.parse(value)
        if (Array.isArray(parsed)) return parsed
        throw new Error('tasks JSON is not an array')
      } catch (err) {
        throw new Error('cannot parse ' + name + ': ' + err.message)
      }
    }
    return value.split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter(Boolean)
  }
  throw new Error(name + ' must be an array, JSON text, JSONL text, or null')
}

function collectEvents (events) {
  const lines = asLines(events, 'events')
  const starts = new Map()
  const deadlines = new Map()
  const samples = new Map()

  for (const line of lines) {
    if (!line || typeof line !== 'object') continue
    if (line.type === 'event' && line.ev === 'start' && typeof line.task === 'string') {
      if (!starts.has(line.task)) starts.set(line.task, line)
    } else if (line.type === 'event' && line.ev === 'deadline' &&
      typeof line.task === 'string') {
      deadlines.set(line.task, line)
    } else if (line.type === 'sample' && typeof line.task === 'string') {
      if (!samples.has(line.task)) samples.set(line.task, [])
      samples.get(line.task).push(line)
    }
  }

  for (const list of samples.values()) {
    list.sort((a, b) => (toNumber(a.ts) || 0) - (toNumber(b.ts) || 0))
  }

  return { starts, deadlines, samples }
}

function taskSkeletons (tasks, index) {
  const list = asLines(tasks, 'tasks')
  if (list.length > 0) {
    return {
      source: 'tasks.json',
      tasks: list
        .filter(task => task && typeof task === 'object' && typeof task.task === 'string')
        .map(task => ({
          task: task.task,
          kind: typeof task.kind === 'string' ? task.kind : null,
          role: typeof task.role === 'string' ? task.role : null,
          step: toNumber(task.step),
          startedAt: task.startedAt ?? null,
          stoppedAt: task.stoppedAt ?? null,
          vcpu: toNumber(task.vcpu),
          memMiB: toNumber(task.memMiB),
          storageGiB: toNumber(task.storageGiB ?? task.ephemeralGiB ?? task.diskGiB),
          publicIp: typeof task.publicIp === 'string' && task.publicIp ? task.publicIp : null,
          image: typeof task.image === 'string' ? task.image : null
        }))
    }
  }

  const tasksById = new Map()
  for (const start of index.starts.values()) {
    tasksById.set(start.task, {
      task: start.task,
      kind: typeof start.kind === 'string' ? start.kind : null,
      role: typeof start.role === 'string' ? start.role : null,
      step: null,
      startedAt: start.detail?.startedAt ?? start.ts ?? null,
      stoppedAt: null,
      vcpu: toNumber(start.detail?.vcpu),
      memMiB: toNumber(start.detail?.memMiB),
      storageGiB: null,
      publicIp: null,
      image: typeof start.detail?.image === 'string' ? start.detail.image : null
    })
  }

  if (tasksById.size === 0) {
    for (const [task, list] of index.samples) {
      const sample = list[0]
      tasksById.set(task, {
        task,
        kind: typeof sample.kind === 'string' ? sample.kind : null,
        role: typeof sample.role === 'string' ? sample.role : null,
        step: null,
        startedAt: sample.ts ?? null,
        stoppedAt: null,
        vcpu: null,
        memMiB: null,
        storageGiB: null,
        publicIp: null,
        image: null
      })
    }
  }

  return {
    source: tasksById.size > 0 ? 'events' : 'none',
    tasks: [...tasksById.values()]
  }
}

function readTask (skeleton, index) {
  const task = skeleton.task
  const start = index.starts.get(task) || null
  const deadline = index.deadlines.get(task) || null
  const samples = index.samples.get(task) || []
  const last = samples.length > 0 ? samples[samples.length - 1] : null

  if (skeleton.kind === null && typeof start?.kind === 'string') skeleton.kind = start.kind
  if (skeleton.role === null && typeof start?.role === 'string') skeleton.role = start.role

  const startedAt = skeleton.startedAt ?? start?.detail?.startedAt ?? start?.ts ?? null
  const stoppedAt = skeleton.stoppedAt ?? deadline?.ts ?? last?.ts ?? null
  const startMs = timeMs(startedAt)
  const stopMs = timeMs(stoppedAt)
  const lastSampleTs = timeMs(last?.ts)

  let elapsedHours = null
  if (startMs !== null && stopMs !== null && stopMs >= startMs) {
    elapsedHours = (stopMs - startMs) / HOUR_MS
  }

  let txBytes = null
  let rxBytes = null
  for (const sample of samples) {
    const tx = toNumber(sample.ecs?.tx)
    if (tx !== null) txBytes = txBytes === null ? tx : Math.max(txBytes, tx)
    const rx = toNumber(sample.ecs?.rx)
    if (rx !== null) rxBytes = rxBytes === null ? rx : Math.max(rxBytes, rx)
  }

  const natHost = last?.probe?.nat?.host
  const publicIp = skeleton.publicIp ||
    (typeof natHost === 'string' && natHost.length > 0 ? natHost : null)

  const vcpu = skeleton.vcpu ?? toNumber(start?.detail?.vcpu)
  const memMiB = skeleton.memMiB ?? toNumber(start?.detail?.memMiB)

  return {
    ...skeleton,
    startEvent: start,
    deadline,
    samples,
    lastSample: last,
    startedAt: startMs !== null ? new Date(startMs).toISOString() : null,
    stoppedAt: stopMs !== null ? new Date(stopMs).toISOString() : null,
    startMs,
    stopMs,
    lastSampleMs: lastSampleTs,
    elapsedHours,
    vcpu,
    memMiB,
    hasPublicIp: publicIp !== null,
    txBytes,
    rxBytes
  }
}

function emptyBucket (label) {
  return {
    label,
    tasks: 0,
    taskHours: 0,
    vcpuHours: 0,
    gbHours: 0,
    ipv4Hours: 0,
    txBytes: 0,
    storageGbHours: 0,
    usd: { compute: 0, ipv4: 0, tx: 0, storage: 0, total: 0 },
    missingCounts: { hours: 0, compute: 0, ipv4: 0, tx: 0 }
  }
}

function addToBucket (bucket, task) {
  bucket.tasks += 1
  if (task.hours !== null) bucket.taskHours += task.hours
  else bucket.missingCounts.hours += 1
  if (task.vcpuHours !== null && task.gbHours !== null) {
    bucket.vcpuHours += task.vcpuHours
    bucket.gbHours += task.gbHours
  } else {
    bucket.missingCounts.compute += 1
  }
  if (task.ipv4Hours !== null) bucket.ipv4Hours += task.ipv4Hours
  else bucket.missingCounts.ipv4 += 1
  if (task.txBytes !== null) bucket.txBytes += task.txBytes
  else bucket.missingCounts.tx += 1
  if (task.storageGbHours !== null) bucket.storageGbHours += task.storageGbHours

  if (task.usd.compute !== null) bucket.usd.compute += task.usd.compute
  if (task.usd.ipv4 !== null) bucket.usd.ipv4 += task.usd.ipv4
  if (task.usd.tx !== null) bucket.usd.tx += task.usd.tx
  if (task.usd.storage !== null) bucket.usd.storage += task.usd.storage

  bucket.usd.total = bucket.usd.compute + bucket.usd.ipv4 + bucket.usd.tx +
    bucket.usd.storage
  return bucket
}

function bucketMissing (bucket) {
  return Object.keys(bucket.missingCounts).filter(key => bucket.missingCounts[key] > 0)
}

// Price one run.
//
// tasks: rows in the `tasks.json` shape, or [] to infer tasks from `start`
//        events (and then from sample task ids if there are no start events).
// events: parsed JSON objects or JSONL text. Sample lines, start/deadline
//         events, owner, scrape and home lines are all accepted; only sample
//         and start/deadline lines affect cost.
// logBytes: CloudWatch Logs ingested bytes, or null when the caller has none.
// arch: 'amd64' or 'arm64'.
//
// Every unknown value is null with a reason string. `expected.complete` is true
// only when compute, IPv4, tx, storage and logs all have a value. ECR is always
// n/a because the run does not record image sizes.
export function calculateCost (tasks, events, logBytes, arch = 'amd64') {
  const rates = ratesFor(arch)
  const index = collectEvents(events)
  const skeletons = taskSkeletons(tasks, index)
  const measured = skeletons.tasks.map(skeleton => readTask(skeleton, index))

  const priced = measured.map(task => {
    const hours = task.elapsedHours
    const vcpuHours = hours !== null && task.vcpu !== null ? hours * task.vcpu : null
    const gbHours = hours !== null && task.memMiB !== null
      ? hours * (task.memMiB / 1024)
      : null

    const storageGiB = task.storageGiB ?? PRICES.ephemeralStorage.freeGb
    const extraStorageGiB = Math.max(0, storageGiB - PRICES.ephemeralStorage.freeGb)
    const storageGbHours = extraStorageGiB === 0
      ? 0
      : hours !== null ? extraStorageGiB * hours : null

    const reasons = {}
    let compute = null
    if (vcpuHours === null || gbHours === null) {
      reasons.compute = hours === null
        ? 'no usable start and stop time'
        : 'no vCPU or memory in tasks.json or the start event'
    } else {
      compute = vcpuHours * rates.vcpuHour + gbHours * rates.gbHour
    }

    let ipv4Hours = null
    let ipv4 = null
    if (!task.hasPublicIp) {
      reasons.ipv4 = 'no public IP in tasks.json or probe.nat.host'
    } else if (hours === null) {
      reasons.ipv4 = 'no usable start and stop time'
    } else {
      ipv4Hours = hours
      ipv4 = hours * PRICES.ipv4Hour
    }

    let tx = null
    if (task.txBytes === null) {
      reasons.tx = 'no ECS tx counter in the task samples'
    } else {
      tx = task.txBytes / GB * PRICES.transfer.regionalGb
    }

    let storage = null
    if (storageGbHours === null) {
      reasons.storage = 'no task lifetime for declared storage'
    } else {
      storage = storageGbHours * PRICES.ephemeralStorage.gbHour
    }

    const known = [compute, ipv4, tx, storage].filter(value => value !== null)
    const total = known.reduce((sum, value) => sum + value, 0)

    reasons.logs = 'logs are billed for the run, not per task'
    reasons.ecr = 'ECR storage is monthly; image sizes are not in the run counters'

    return {
      task: task.task,
      kind: task.kind,
      role: task.role,
      step: task.step,
      startedAt: task.startedAt,
      stoppedAt: task.stoppedAt,
      hours,
      vcpu: task.vcpu,
      memMiB: task.memMiB,
      vcpuHours,
      gbHours,
      ipv4Hours,
      hasPublicIp: task.hasPublicIp,
      txBytes: task.txBytes,
      rxBytes: task.rxBytes,
      storageGiB,
      extraStorageGiB,
      storageGbHours,
      usd: {
        compute,
        ipv4,
        tx,
        logs: null,
        storage,
        ecr: null,
        total,
        complete: Object.keys(reasons).every(key => key === 'logs' || key === 'ecr')
      },
      reasons
    }
  })

  const byStep = {}
  const byKind = {}
  for (const task of priced) {
    const stepKey = task.step === null ? 'unknown' : String(task.step)
    if (!byStep[stepKey]) byStep[stepKey] = emptyBucket(stepKey)
    addToBucket(byStep[stepKey], task)
    const kindKey = task.kind || 'unknown'
    if (!byKind[kindKey]) byKind[kindKey] = emptyBucket(kindKey)
    addToBucket(byKind[kindKey], task)
  }

  for (const bucket of [...Object.values(byStep), ...Object.values(byKind)]) {
    bucket.missingFields = bucketMissing(bucket)
  }

  const expected = emptyBucket('expected')
  for (const task of priced) addToBucket(expected, task)

  const validLogs = typeof logBytes === 'number' && Number.isFinite(logBytes) && logBytes >= 0
  expected.logBytes = validLogs ? logBytes : null
  expected.usd.logs = validLogs ? logBytes / GB * PRICES.logsGb : null
  expected.usd.ecr = null
  expected.usd.total = expected.usd.compute + expected.usd.ipv4 + expected.usd.tx +
    expected.usd.storage + (expected.usd.logs || 0)
  expected.missingFields = bucketMissing(expected)
  if (!validLogs) expected.missingFields.push('logs')
  expected.missingFields.push('ecr')
  expected.complete = expected.missingFields.length === 0
  expected.missing = []
  if (!validLogs) {
    expected.missing.push('logs: no logBytes input; pass the CloudWatch ingested size')
  }
  expected.missing.push('ecr: image sizes are not collected')
  for (const field of ['hours', 'compute', 'ipv4', 'tx']) {
    const count = expected.missingCounts[field]
    if (count > 0) expected.missing.push(field + ': ' + count + ' task(s) without a value')
  }
  expected.notes = [
    'ECR storage is not in the total: image sizes are not part of the run counters.'
  ]

  const tripHours = CAPS.hours
  const averageComputePerHour = maximumComputePerHour(arch)
  const averageSizing = maximumSizing()
  const worstCompute = tripHours * averageComputePerHour
  const worstIpv4 = tripHours * PRICES.ipv4Hour
  const worstTx = CAPS.txBytes / GB * PRICES.transfer.txGb
  const worstLogs = CAPS.logBytes / GB * PRICES.logsGb
  const worstTotal = worstCompute + worstIpv4 + worstTx + worstLogs

  const worst = {
    trip: CAPS.trip,
    taskHours: tripHours,
    vcpuHours: tripHours * averageSizing.vcpu,
    gbHours: tripHours * averageSizing.memGiB,
    ipv4Hours: tripHours,
    txBytes: CAPS.txBytes,
    logBytes: CAPS.logBytes,
    averageComputePerHour,
    usd: {
      compute: worstCompute,
      ipv4: worstIpv4,
      tx: worstTx,
      logs: worstLogs,
      storage: 0,
      ecr: null,
      total: worstTotal
    },
    ceilingUsd: CEILING_USD,
    underCeiling: worstTotal < CEILING_USD,
    notes: [
      'Prices every hard cap at the highest task compute rate and all sent bytes at both transfer rates.',
      'ECR storage is excluded because image sizes are not collected.'
    ]
  }

  return {
    pricedAt: PRICES.pricedAt,
    region: PRICES.region,
    arch,
    tasks: priced,
    byStep,
    byKind,
    expected,
    worst,
    caps: CAPS,
    rates: {
      vcpuHour: rates.vcpuHour,
      gbHour: rates.gbHour,
      ipv4Hour: PRICES.ipv4Hour,
      txGb: PRICES.transfer.txGb,
      logsGb: PRICES.logsGb,
      storageGbHour: PRICES.ephemeralStorage.gbHour,
      ecrGbMonth: PRICES.ecrGbMonth
    },
    sources: {
      tasks: skeletons.source,
      events: Array.isArray(events) ? 'array' : typeof events === 'string' ? 'jsonl' : 'none'
    }
  }
}
