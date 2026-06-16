import { existsSync, mkdirSync, readFileSync, writeFileSync } from '#fs'
import { join } from '#path'
import { RELAY_MODERATION_FILENAME } from './constants.js'
import { normalizeModerationRule } from './moderation.js'

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

function readStore(path) {
  if (!existsSync(path)) {
    return {
      version: 1,
      updatedAt: Date.now(),
      rules: []
    }
  }

  return JSON.parse(readFileSync(path, 'utf8'))
}

function nextRuleId(rules) {
  let index = rules.length + 1
  const existing = new Set(rules.map((rule) => rule.id).filter(Boolean))
  while (existing.has(`mod_${index.toString(36)}`)) index += 1
  return `mod_${index.toString(36)}`
}

export class ModerationRuleStore {
  constructor({ storagePath, moderationPath, data, nowFn = Date.now }) {
    this.storagePath = storagePath
    this.moderationPath = moderationPath
    this.data = data
    this.nowFn = nowFn
  }

  static async open({ storagePath, moderationPath = join(storagePath, RELAY_MODERATION_FILENAME), nowFn = Date.now }) {
    ensureDir(storagePath)
    ensureParentDir(moderationPath)
    const data = readStore(moderationPath)
    return new ModerationRuleStore({ storagePath, moderationPath, data, nowFn })
  }

  async persist() {
    this.data.updatedAt = Number(this.nowFn()) || Date.now()
    ensureParentDir(this.moderationPath)
    writeFileSync(this.moderationPath, JSON.stringify(this.data, null, 2))
  }

  getRules() {
    return (this.data.rules || []).map((rule) => clone(rule))
  }

  async addRule(rule) {
    const normalized = normalizeModerationRule(rule)
    const existing = (this.data.rules || []).find((entry) => (
      entry.targetType === normalized.targetType &&
      entry.target === normalized.target &&
      entry.action === normalized.action &&
      (entry.source || 'local') === (normalized.source || 'local')
    ))
    const record = {
      ...normalized,
      id: existing?.id || normalized.id || nextRuleId(this.data.rules || []),
      createdAt: Number(normalized.createdAt || existing?.createdAt || this.nowFn()) || Date.now()
    }

    if (existing) {
      const index = this.data.rules.indexOf(existing)
      this.data.rules[index] = record
    } else {
      this.data.rules = [...(this.data.rules || []), record]
    }

    await this.persist()
    return clone(record)
  }

  async removeRule(id) {
    const ruleId = typeof id === 'string' ? id.trim() : ''
    if (!ruleId) return null
    const rules = this.data.rules || []
    const index = rules.findIndex((rule) => rule.id === ruleId)
    if (index < 0) return null

    const [removed] = rules.splice(index, 1)
    await this.persist()
    return clone(removed)
  }
}
