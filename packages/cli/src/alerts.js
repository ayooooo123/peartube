import { existsSync, mkdirSync, readFileSync, writeFileSync } from '#fs'
import { join } from '#path'
import { RELAY_ALERTS_FILENAME } from './constants.js'

const VALID_SEVERITIES = ['info', 'warning', 'critical']
const VALID_CATEGORIES = ['posture', 'moderation', 'storage', 'archive', 'network']

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function ensureParentDir(path) {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (separatorIndex > 0) ensureDir(path.slice(0, separatorIndex))
}

function nowValue(nowFn) {
  return Number(nowFn()) || Date.now()
}

function readStore(path) {
  if (!existsSync(path)) {
    return {
      version: 1,
      updatedAt: Date.now(),
      alerts: []
    }
  }

  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return {
    version: 1,
    ...parsed,
    alerts: Array.isArray(parsed.alerts) ? parsed.alerts : []
  }
}

function nextAlertId(alerts) {
  let index = alerts.length + 1
  const existing = new Set(alerts.map((alert) => alert.id).filter(Boolean))
  while (existing.has(`alert_${index.toString(36)}`)) index += 1
  return `alert_${index.toString(36)}`
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeAlert(input = {}, { now, existing, id } = {}) {
  const severity = normalizeString(input.severity) || existing?.severity || 'warning'
  if (!VALID_SEVERITIES.includes(severity)) {
    throw new Error(`Unsupported alert severity "${severity}"`)
  }

  const category = normalizeString(input.category) || existing?.category || ''
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`Unsupported alert category "${category}"`)
  }

  const targetType = normalizeString(input.targetType) || existing?.targetType || 'none'
  const target = normalizeString(input.target) || existing?.target || 'none'
  const summary = normalizeString(input.summary) || existing?.summary || ''
  if (!summary) throw new Error('alerts require a summary')

  const suggestedActions = Array.isArray(input.suggestedActions)
    ? input.suggestedActions.map((action) => normalizeString(action)).filter(Boolean)
    : (Array.isArray(existing?.suggestedActions) ? existing.suggestedActions : [])

  const createdAt = Number(input.createdAt || existing?.createdAt || now) || now
  const occurrences = Number(existing?.occurrences || input.occurrences || 0) + (existing ? 1 : 0)

  return {
    id: id || input.id || existing?.id,
    severity,
    category,
    targetType,
    target,
    summary,
    createdAt,
    lastSeenAt: Number(input.lastSeenAt || now) || now,
    occurrences: existing ? occurrences : Math.max(1, Number(input.occurrences || 1) || 1),
    ...(Number(input.acknowledgedAt || existing?.acknowledgedAt) ? { acknowledgedAt: Number(input.acknowledgedAt || existing?.acknowledgedAt) } : {}),
    ...(suggestedActions.length ? { suggestedActions } : {})
  }
}

function alertFingerprint(alert = {}) {
  return [
    normalizeString(alert.category),
    normalizeString(alert.targetType),
    normalizeString(alert.target),
    normalizeString(alert.summary)
  ].join('\0')
}

function sortLatest(left, right) {
  return (Number(right.lastSeenAt || right.createdAt || 0) || 0) - (Number(left.lastSeenAt || left.createdAt || 0) || 0)
}

function activeAlerts(alerts = []) {
  return alerts.filter((alert) => !alert?.acknowledgedAt)
}

export function summarizeAlerts(alerts = []) {
  const summary = {
    info: 0,
    warning: 0,
    critical: 0,
    unacknowledged: 0
  }

  for (const alert of activeAlerts(alerts)) {
    if (Object.hasOwn(summary, alert?.severity)) summary[alert.severity] += 1
    summary.unacknowledged += 1
  }

  return summary
}

export function latestAlerts(alerts = [], { limit = 5 } = {}) {
  const sorted = activeAlerts(alerts).sort(sortLatest)
  if (!Number.isFinite(Number(limit)) || Number(limit) < 0) return sorted.map((alert) => clone(alert))
  return sorted.slice(0, Number(limit)).map((alert) => clone(alert))
}

export class AlertStore {
  constructor({ storagePath, alertsPath, data, nowFn = Date.now }) {
    this.storagePath = storagePath
    this.alertsPath = alertsPath
    this.data = data
    this.nowFn = nowFn
  }

  static async open({ storagePath, alertsPath = join(storagePath, RELAY_ALERTS_FILENAME), nowFn = Date.now }) {
    ensureDir(storagePath)
    ensureParentDir(alertsPath)
    const data = readStore(alertsPath)
    return new AlertStore({ storagePath, alertsPath, data, nowFn })
  }

  async persist() {
    this.data.updatedAt = nowValue(this.nowFn)
    ensureParentDir(this.alertsPath)
    writeFileSync(this.alertsPath, JSON.stringify(this.data, null, 2))
  }

  getAlerts({ includeAcknowledged = false, limit = 50 } = {}) {
    const alerts = includeAcknowledged ? [...(this.data.alerts || [])] : activeAlerts(this.data.alerts || [])
    const sorted = alerts.sort(sortLatest)
    const selected = Number.isFinite(Number(limit)) && Number(limit) >= 0
      ? sorted.slice(0, Number(limit))
      : sorted
    return selected.map((alert) => clone(alert))
  }

  getSummary() {
    return summarizeAlerts(this.data.alerts || [])
  }

  async addAlert(alert) {
    const now = nowValue(this.nowFn)
    const normalized = normalizeAlert(alert, { now, id: alert?.id || nextAlertId(this.data.alerts || []) })
    const fingerprint = alertFingerprint(normalized)
    const existing = (this.data.alerts || []).find((entry) => !entry.acknowledgedAt && alertFingerprint(entry) === fingerprint)

    if (existing) {
      const index = this.data.alerts.indexOf(existing)
      const updated = normalizeAlert({ ...normalized, id: existing.id }, { now, existing, id: existing.id })
      this.data.alerts[index] = updated
      await this.persist()
      return clone(updated)
    }

    this.data.alerts = [...(this.data.alerts || []), normalized]
    await this.persist()
    return clone(normalized)
  }

  async ensureAlert(alert) {
    const now = nowValue(this.nowFn)
    const normalized = normalizeAlert(alert, { now, id: alert?.id || nextAlertId(this.data.alerts || []) })
    const fingerprint = alertFingerprint(normalized)
    const existing = (this.data.alerts || []).find((entry) => alertFingerprint(entry) === fingerprint)

    if (existing) {
      const index = this.data.alerts.indexOf(existing)
      const updated = normalizeAlert({ ...normalized, id: existing.id }, { now, existing, id: existing.id })
      this.data.alerts[index] = updated
      await this.persist()
      return clone(updated)
    }

    this.data.alerts = [...(this.data.alerts || []), normalized]
    await this.persist()
    return clone(normalized)
  }

  async acknowledgeAlert(id) {
    const alertId = normalizeString(id)
    if (!alertId) return null
    const existing = (this.data.alerts || []).find((alert) => alert.id === alertId)
    if (!existing) return null

    existing.acknowledgedAt = existing.acknowledgedAt || nowValue(this.nowFn)
    await this.persist()
    return clone(existing)
  }
}
