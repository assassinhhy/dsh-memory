/**
 * Weekly consolidation (NOT Dreaming). One bounded model call over entry
 * summaries + metadata produces review suggestions — merge / stale / promote /
 * conflict — written to review/YYYY-Www.json (+ .md). Nothing is ever applied
 * automatically: a person accepts, rejects, or edits each one. Pinned entries
 * can only appear in merge/conflict suggestions, never in stale.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DAY_MS, toMs } from './decay.js'
import { extractJson } from './review.js'
import { zonedDay, zonedStamp } from './paths.js'

export const SUGGESTION_TYPES = Object.freeze(['merge', 'stale', 'promote', 'conflict'])
export const DEFAULT_MAX_BATCH_CHARS = 6000
export const DEFAULT_INTERVAL_DAYS = 7
const EXCERPT_CHARS = 160

const SYSTEM = `你是本地记忆整理员。下面是一批记忆条目的摘要和元数据（不是全文）。
只输出一个 JSON 对象：{"suggestions":[...]}，不要 markdown 围栏，不要解释。
每个建议是一个对象：
- {"type":"merge","ids":[...],"text":"合并后的文本","reason":"..."}：重复或近似条目合并。ids 至少 2 个，text 是合并后的完整文本。
- {"type":"stale","ids":[...],"reason":"..."}：长期未用或已过时，建议归档。ids 至少 1 个。置顶条目（pinned=true）不要放进 stale。
- {"type":"promote","text":"...","target":"user|memory","ids":[...],"reason":"..."}：日记里反复出现、值得常驻的事实，建议写进 USER.md/MEMORY.md。只建议，不写入。
- {"type":"conflict","ids":[...],"text":"建议的统一说法，可留空","reason":"..."}：互相矛盾的条目，ids 列出两边。
只使用给出的 id。没有值得提的就输出 {"suggestions":[]}。`

/** ISO week in the user's zone: 2026-W43. */
export function isoWeek(date, timeZone = 'Asia/Shanghai') {
  const day = zonedDay(date, timeZone)
  const [year, month, dateNum] = day.split('-').map(Number)
  const utc = new Date(Date.UTC(year, month - 1, dateNum))
  const dayNum = utc.getUTCDay() || 7
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7)
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function excerpt(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS)
}

/**
 * Entry summaries + metadata only — never full journal prose.
 * Returns batches so a big corpus stays under the per-call char threshold.
 */
export function buildDigest(entries, { maxChars = DEFAULT_MAX_BATCH_CHARS } = {}) {
  const cap = Math.max(500, Number(maxChars) || DEFAULT_MAX_BATCH_CHARS)
  const lines = (entries ?? []).map((entry) => {
    const pinned = entry.pinned ? 'true' : 'false'
    const lastUsed = entry.lastUsedAt ? zonedStamp(new Date(toMs(entry.lastUsedAt))) : 'never'
    const created = entry.createdAt ? zonedStamp(new Date(toMs(entry.createdAt))) : 'unknown'
    return `- ${entry.id} | ${entry.file} | pinned=${pinned} uses=${Number(entry.useCount) || 0} created=${created} last_used=${lastUsed}${entry.tags ? ` tags=${entry.tags}` : ''}\n  ${excerpt(entry.text)}`
  })
  const batches = []
  let current = []
  let size = 0
  for (const line of lines) {
    if (current.length > 0 && size + line.length + 1 > cap) {
      batches.push({ text: current.join('\n'), ids: currentIds(current) })
      current = []
      size = 0
    }
    current.push(line)
    size += line.length + 1
  }
  if (current.length > 0) batches.push({ text: current.join('\n'), ids: currentIds(current) })
  return batches
}

function currentIds(lines) {
  return lines.map((line) => /^- (\S+) \|/u.exec(line)?.[1]).filter(Boolean)
}

export function buildConsolidateMessages(batchText) {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        '记忆条目摘要（含元数据）：',
        String(batchText).trim() === '' ? '（空）' : String(batchText).trim(),
        '',
        '只输出一个 JSON 对象 {"suggestions":[...]}。',
      ].join('\n'),
    },
  ]
}

function asIdList(value) {
  if (!Array.isArray(value)) return []
  const ids = []
  for (const item of value) {
    const id = String(item ?? '').trim()
    if (id !== '' && id.length <= 64 && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** Fail closed: invalid items are dropped, never thrown into the conversation. */
export function parseSuggestions(raw) {
  const value = extractJson(raw)
  if (!value || typeof value !== 'object' || !Array.isArray(value.suggestions)) {
    return { ok: true, suggestions: [] }
  }
  const suggestions = []
  for (const item of value.suggestions) {
    if (!item || typeof item !== 'object') continue
    const type = String(item.type ?? '').toLowerCase()
    if (!SUGGESTION_TYPES.includes(type)) continue
    const ids = asIdList(item.ids)
    const reason = item.reason === undefined ? '' : String(item.reason).slice(0, 400)
    const text = item.text === undefined ? '' : String(item.text).trim()
    const target = String(item.target ?? '')
    if (type === 'merge') {
      if (ids.length < 2 || text === '') continue
      suggestions.push({ type, ids, text, reason })
      continue
    }
    if (type === 'stale') {
      if (ids.length < 1) continue
      suggestions.push({ type, ids, reason })
      continue
    }
    if (type === 'promote') {
      if (text === '' || (target !== 'user' && target !== 'memory')) continue
      suggestions.push({ type, ids, text, target, reason })
      continue
    }
    // conflict: both sides listed; unified wording is optional (the user can edit).
    if (ids.length < 2) continue
    suggestions.push({ type, ids, ...(text ? { text } : {}), reason })
  }
  return { ok: true, suggestions }
}

/** Pinned entries may only appear in merge/conflict — never in stale. */
export function filterPinnedStale(suggestions, isPinned) {
  const kept = []
  const dropped = []
  for (const suggestion of suggestions ?? []) {
    if (suggestion.type !== 'stale') {
      kept.push(suggestion)
      continue
    }
    const ids = []
    const droppedIds = []
    for (const id of suggestion.ids) {
      if (isPinned(id)) droppedIds.push(id)
      else ids.push(id)
    }
    if (droppedIds.length > 0) dropped.push({ ...suggestion, droppedIds })
    if (ids.length === 0) continue
    kept.push(droppedIds.length > 0 ? { ...suggestion, ids, droppedIds } : suggestion)
  }
  return { suggestions: kept, dropped }
}

export function suggestionSignature(suggestion) {
  return `${suggestion.type}|${[...suggestion.ids].sort().join(',')}`
}

export function renderReviewMarkdown(review) {
  const lines = [
    `# 整理建议 ${review.week}`,
    '',
    `生成时间：${review.generatedAt}${review.generator?.model ? ` · 模型：${review.generator.model}` : ''}`,
    '',
    '每条可以：同意 / 拒绝 / 编辑后同意。置顶条目永远不会出现在 stale 里。归档可恢复，不是删除。',
    '',
  ]
  const titles = { merge: '合并', stale: '过时（建议归档）', promote: '晋升（只建议）', conflict: '冲突' }
  for (const type of SUGGESTION_TYPES) {
    const items = (review.suggestions ?? []).filter((item) => item.type === type)
    if (items.length === 0) continue
    lines.push(`## ${titles[type]}`, '')
    for (const item of items) {
      const mark = item.status === 'accepted' ? 'x' : ' '
      lines.push(`- [${mark}] ${item.key}（${item.status}）ids=${item.ids.join(', ')}`)
      if (item.reason) lines.push(`  - 理由：${item.reason}`)
      if (item.text) lines.push(`  - 文本：${item.text.replace(/\s+/g, ' ').trim()}`)
      if (item.droppedIds?.length) lines.push(`  - 已剔除置顶：${item.droppedIds.join(', ')}`)
      if (item.resolution) lines.push(`  - 处理：${item.resolution}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

async function readOrEmpty(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

async function writeAtomic(file, content) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, content, 'utf8')
  try {
    await rename(tmp, file)
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') {
      await rm(tmp, { force: true })
      throw error
    }
    await rm(file, { force: true })
    await rename(tmp, file)
  }
}

/**
 * @param {{
 *   root: string,
 *   store: { list: Function, read: Function },
 *   meta?: { byId: Function, kvGet: Function, kvSet: Function },
 *   actions: { archive: Function, replace: Function, add: Function },
 *   callModel: (args: { system: string, user: string, maxTokens?: number, provider?: string, model?: string }) => Promise<string>,
 *   now?: () => Date | number | string,
 *   tz?: string,
 *   maxBatchChars?: number,
 *   intervalDays?: number,
 * }} options
 */
export function createConsolidation(options) {
  const root = options.root
  const store = options.store
  const meta = options.meta
  const actions = options.actions
  const callModel = options.callModel
  const now = options.now ?? (() => new Date())
  const tz = options.tz ?? 'Asia/Shanghai'
  const maxBatchChars = Number(options.maxBatchChars) || DEFAULT_MAX_BATCH_CHARS
  const intervalDays = Number(options.intervalDays) || DEFAULT_INTERVAL_DAYS

  const reviewDir = () => join(root, 'review')
  const reviewJson = (week) => join(reviewDir(), `${week}.json`)
  const reviewMd = (week) => join(reviewDir(), `${week}.md`)

  async function readReview(week) {
    const raw = await readOrEmpty(reviewJson(week))
    if (raw.trim() === '') return undefined
    try {
      const value = JSON.parse(raw)
      if (!value || typeof value !== 'object' || !Array.isArray(value.suggestions)) return undefined
      return value
    } catch {
      return undefined
    }
  }

  async function writeReview(review) {
    await writeAtomic(reviewJson(review.week), `${JSON.stringify(review, null, 2)}\n`)
    await writeAtomic(reviewMd(review.week), renderReviewMarkdown(review))
    return reviewJson(review.week)
  }

  async function listReviewFiles() {
    let names = []
    try {
      names = await readdir(reviewDir())
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    return names.filter((name) => /^\d{4}-W\d{2}\.json$/u.test(name)).sort()
  }

  function pinnedSet(entries) {
    return new Set(entries.filter((entry) => entry.pinned).map((entry) => entry.id))
  }

  async function collectEntries() {
    const metaById = meta ? meta.byId() : new Map()
    const entries = []
    const take = (file, items) => {
      for (const item of items ?? []) {
        if (!item.id || item.id === 'unfenced') continue
        const row = metaById.get(item.id)
        entries.push({
          id: item.id,
          file,
          text: item.text,
          tags: item.tags ?? '',
          pinned: row?.pinned ?? file === 'user',
          useCount: row?.useCount ?? 0,
          createdAt: row?.createdAt ?? null,
          lastUsedAt: row?.lastUsedAt ?? null,
        })
      }
    }
    for (const file of ['user', 'memory']) {
      const listed = await store.list(file)
      take(file, listed.entries)
    }
    take('journal', (await store.list('journal')).entries)
    return entries
  }

  async function saveSuggestions(week, suggestions, generator) {
    const existing = (await readReview(week)) ?? {
      week,
      generatedAt: zonedStamp(new Date(toMs(now())), tz),
      ...(generator ? { generator } : {}),
      suggestions: [],
    }
    const seen = new Set(existing.suggestions.map(suggestionSignature))
    let counter = existing.suggestions.reduce((max, item) => {
      const n = Number(/^s-(\d+)$/u.exec(item.key ?? '')?.[1])
      return Number.isFinite(n) && n > max ? n : max
    }, 0)
    for (const suggestion of suggestions) {
      const signature = suggestionSignature(suggestion)
      if (seen.has(signature)) continue
      seen.add(signature)
      counter += 1
      existing.suggestions.push({
        key: `s-${counter}`,
        status: 'pending',
        decidedAt: null,
        resolution: null,
        ...suggestion,
      })
    }
    existing.generatedAt = zonedStamp(new Date(toMs(now())), tz)
    if (generator) existing.generator = generator
    await writeReview(existing)
    return existing
  }

  async function findSuggestion(week, key) {
    const review = await readReview(week)
    if (!review) return undefined
    const suggestion = review.suggestions.find((item) => item.key === key)
    return suggestion ? { review, suggestion } : undefined
  }

  return {
    root,
    intervalDays,

    async status() {
      const lastRaw = meta?.kvGet?.('consolidate.lastAt')
      const lastAt = toMs(lastRaw) ?? null
      const due = lastAt === null || (toMs(now()) - lastAt) / DAY_MS >= intervalDays
      return {
        lastAt,
        nextAt: lastAt === null ? null : lastAt + intervalDays * DAY_MS,
        due,
        intervalDays,
      }
    },

    async list() {
      const out = []
      for (const name of await listReviewFiles()) {
        const review = await readReview(name.replace(/\.json$/u, ''))
        if (!review) continue
        for (const suggestion of review.suggestions) out.push({ ...suggestion, week: review.week })
      }
      return out
    },

    /**
     * One model call per digest batch (a single call when the summaries fit).
     * Suggestions are validated and pinned-filtered before they touch disk.
     */
    async run({ provider, model, maxTokens = 1200, session, agent, signal } = {}) {
      const entries = await collectEntries()
      const batches = buildDigest(entries, { maxChars: maxBatchChars })
      if (batches.length === 0) {
        const week = isoWeek(new Date(toMs(now())), tz)
        const saved = await saveSuggestions(week, [], provider || model ? { provider, model } : undefined)
        if (meta?.kvSet) meta.kvSet('consolidate.lastAt', String(toMs(now())))
        return { ok: true, week, batches: 0, suggestions: saved.suggestions, file: reviewJson(week) }
      }
      const pinned = pinnedSet(entries)
      const parsed = []
      for (const batch of batches) {
        const messages = buildConsolidateMessages(batch.text)
        const raw = await callModel({
          system: messages[0].content,
          user: messages[1].content,
          maxTokens,
          provider,
          model,
          session,
          agent,
          signal,
        })
        parsed.push(...parseSuggestions(raw).suggestions)
      }
      const filtered = filterPinnedStale(parsed, (id) => pinned.has(id))
      const week = isoWeek(new Date(toMs(now())), tz)
      const saved = await saveSuggestions(
        week,
        filtered.suggestions,
        provider || model ? { provider, model } : undefined,
      )
      if (meta?.kvSet) meta.kvSet('consolidate.lastAt', String(toMs(now())))
      return {
        ok: true,
        week,
        batches: batches.length,
        dropped: filtered.dropped,
        suggestions: saved.suggestions,
        file: reviewJson(week),
      }
    },

    /** accept | reject, optionally with edited text ("编辑后同意"). */
    async decide({ week, key, action, text }) {
      const found = await findSuggestion(week, key)
      if (!found) return { ok: false, code: 'not_found', error: '没有这条建议。' }
      const { review, suggestion } = found
      if (suggestion.status !== 'pending') {
        return { ok: false, code: 'already_decided', error: `这条建议已经处理过了（${suggestion.status}）。` }
      }
      const decidedAt = zonedStamp(new Date(toMs(now())), tz)
      if (action === 'reject') {
        suggestion.status = 'rejected'
        suggestion.decidedAt = decidedAt
        await writeReview(review)
        return { ok: true, key, status: 'rejected' }
      }
      if (action !== 'accept') return { ok: false, code: 'bad_action', error: 'action 只能是 accept 或 reject。' }
      const applied = await applySuggestion(suggestion, { text, actions })
      if (!applied.ok) return applied
      suggestion.status = 'accepted'
      suggestion.decidedAt = decidedAt
      if (text !== undefined && String(text).trim() !== '') suggestion.resolution = String(text).trim()
      await writeReview(review)
      return { ok: true, key, status: 'accepted', applied }
    },

    async rejectAll({ week } = {}) {
      const decidedAt = zonedStamp(new Date(toMs(now())), tz)
      let count = 0
      for (const name of await listReviewFiles()) {
        const review = await readReview(name.replace(/\.json$/u, ''))
        if (!review || (week && review.week !== week)) continue
        let changed = false
        for (const suggestion of review.suggestions) {
          if (suggestion.status !== 'pending') continue
          suggestion.status = 'rejected'
          suggestion.decidedAt = decidedAt
          changed = true
          count += 1
        }
        if (changed) await writeReview(review)
      }
      return { ok: true, rejected: count }
    },
  }
}

/** Apply one accepted suggestion. Limit errors come back as failures — nothing is truncated. */
export async function applySuggestion(suggestion, { text, actions }) {
  const type = String(suggestion?.type ?? '')
  if (type === 'stale') {
    const archived = []
    for (const id of suggestion.ids) {
      const result = await actions.archive({ id, reason: suggestion.reason || 'stale' })
      if (result?.ok) archived.push(id)
    }
    if (archived.length === 0) {
      return { ok: false, code: 'not_found', error: '这些条目都不在了，没有可归档的。' }
    }
    return { ok: true, archived }
  }
  if (type === 'merge' || type === 'conflict') {
    const body = String(text ?? suggestion.text ?? '').trim()
    if (body === '') {
      return { ok: false, code: 'needs_text', error: '合并/统一需要给出文本（可以编辑后同意）。' }
    }
    const [keep, ...rest] = suggestion.ids
    const replaced = await actions.replace({ id: keep, text: body })
    if (!replaced?.ok) return replaced
    const archived = []
    for (const id of rest) {
      const result = await actions.archive({ id, reason: type })
      if (result?.ok) archived.push(id)
    }
    return { ok: true, kept: keep, archived }
  }
  if (type === 'promote') {
    const body = String(text ?? suggestion.text ?? '').trim()
    if (body === '') return { ok: false, code: 'needs_text', error: '晋升需要给出文本（可以编辑后同意）。' }
    const target = suggestion.target === 'user' ? 'user' : 'memory'
    const added = await actions.add({ target, text: body })
    return added?.ok ? { ok: true, added: added.id } : added
  }
  return { ok: false, code: 'bad_type', error: '未知的建议类型。' }
}
