import { existsSync, mkdirSync, readFileSync, writeFileSync } from '#fs'
import { join } from '#path'
import { RELAY_REPORTS_FILENAME } from './constants.js'
import { normalizeModerationTargetType, VALID_MODERATION_TARGET_TYPES } from './moderation.js'

const VALID_REPORT_REASONS = ['spam', 'abuse', 'copyright', 'malware', 'other']
const VALID_REPORTERS = ['local', 'remote']

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

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function readStore(path) {
  if (!existsSync(path)) {
    return {
      version: 1,
      updatedAt: Date.now(),
      reports: []
    }
  }

  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return {
    version: 1,
    ...parsed,
    reports: Array.isArray(parsed.reports) ? parsed.reports : []
  }
}

function nextReportId(reports) {
  let index = reports.length + 1
  const existing = new Set(reports.map((report) => report.id).filter(Boolean))
  while (existing.has(`report_${index.toString(36)}`)) index += 1
  return `report_${index.toString(36)}`
}

export function normalizeModerationReport(report = {}, { now = Date.now() } = {}) {
  const targetType = normalizeModerationTargetType(report.targetType)
  const target = normalizeString(report.target)
  const reason = normalizeString(report.reason) || 'other'
  const reporter = normalizeString(report.reporter) || 'local'

  if (!VALID_MODERATION_TARGET_TYPES.includes(targetType)) {
    throw new Error(`Unsupported report target type "${targetType}"`)
  }
  if (!target) throw new Error('reports require a target')
  if (!VALID_REPORT_REASONS.includes(reason)) {
    throw new Error(`Unsupported report reason "${reason}"`)
  }
  if (!VALID_REPORTERS.includes(reporter)) {
    throw new Error(`Unsupported report reporter "${reporter}"`)
  }

  return {
    ...(normalizeString(report.id) ? { id: normalizeString(report.id) } : {}),
    targetType,
    target,
    reason,
    ...(normalizeString(report.comment) ? { comment: normalizeString(report.comment) } : {}),
    reporter,
    createdAt: Number.isFinite(Number(report.createdAt)) ? Number(report.createdAt) : now
  }
}

function sortLatest(left, right) {
  return (Number(right.createdAt || 0) || 0) - (Number(left.createdAt || 0) || 0)
}

export class ReportStore {
  constructor({ storagePath, reportsPath, data, nowFn = Date.now }) {
    this.storagePath = storagePath
    this.reportsPath = reportsPath
    this.data = data
    this.nowFn = nowFn
  }

  static async open({ storagePath, reportsPath = join(storagePath, RELAY_REPORTS_FILENAME), nowFn = Date.now }) {
    ensureDir(storagePath)
    ensureParentDir(reportsPath)
    const data = readStore(reportsPath)
    return new ReportStore({ storagePath, reportsPath, data, nowFn })
  }

  async persist() {
    this.data.updatedAt = Number(this.nowFn()) || Date.now()
    ensureParentDir(this.reportsPath)
    writeFileSync(this.reportsPath, JSON.stringify(this.data, null, 2))
  }

  getReports({ targetType, target, limit = 100 } = {}) {
    const normalizedTargetType = normalizeString(targetType) ? normalizeModerationTargetType(targetType) : ''
    const normalizedTarget = normalizeString(target)
    const reports = [...(this.data.reports || [])]
      .filter((report) => !normalizedTargetType || report.targetType === normalizedTargetType)
      .filter((report) => !normalizedTarget || report.target === normalizedTarget)
      .sort(sortLatest)
    const selected = Number.isFinite(Number(limit)) && Number(limit) >= 0
      ? reports.slice(0, Number(limit))
      : reports
    return selected.map((report) => clone(report))
  }

  async addReport(report) {
    const now = Number(this.nowFn()) || Date.now()
    const normalized = normalizeModerationReport(report, { now })
    const record = {
      ...normalized,
      id: normalized.id || nextReportId(this.data.reports || [])
    }

    this.data.reports = [...(this.data.reports || []), record]
    await this.persist()
    return clone(record)
  }
}
