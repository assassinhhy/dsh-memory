/**
 * Decay scoring for memory retrieval. Pure math — this only reorders hits, it
 * never deletes anything.
 *
 *   score = rrf × decay × (1 + log2(1 + use_count) × boost)
 *   decay = 0.5 ^ (age_since_last_used / half_life)
 *
 * half_life: user 60d, memory 60d, journal 21d (configurable).
 * Pinned entries never decay (decay = 1).
 */

export const DAY_MS = 86400000
export const DEFAULT_USE_BOOST = 0.25
export const DEFAULT_HALF_LIFE_DAYS = Object.freeze({
  user: 60,
  memory: 60,
  journal: 21,
})

/** Accepts Date | epoch ms | numeric string | ISO-ish string. Returns epoch ms or undefined. */
export function toMs(value) {
  if (value == null) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : undefined
  }
  const text = String(value).trim()
  if (/^-?\d+(\.\d+)?$/u.test(text)) {
    const epoch = Number(text)
    return Number.isFinite(epoch) ? epoch : undefined
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Whole/fractional days since the entry was last used (falls back to created). */
export function ageDays(meta, now) {
  const nowMs = toMs(now) ?? Date.now()
  const base = toMs(meta?.lastUsedAt) ?? toMs(meta?.createdAt)
  if (base === undefined) return 0
  return Math.max(0, (nowMs - base) / DAY_MS)
}

export function isPinned(meta) {
  return meta?.pinned === true || meta?.pinned === 1 || meta?.pinned === '1'
}

export function decayFactor({ age, halfLifeDays, pinned }) {
  if (pinned) return 1
  const halfLife = Number(halfLifeDays)
  if (!Number.isFinite(halfLife) || halfLife <= 0) return 1
  const days = Number.isFinite(age) ? Math.max(0, age) : 0
  return 0.5 ** (days / halfLife)
}

export function useFactor(useCount, boost = DEFAULT_USE_BOOST) {
  const raw = Number(useCount)
  const count = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
  const b = Number(boost)
  const weight = Number.isFinite(b) ? b : DEFAULT_USE_BOOST
  return 1 + Math.log2(1 + count) * weight
}

export function halfLifeFor(file, halfLifeDays = DEFAULT_HALF_LIFE_DAYS) {
  const map = halfLifeDays ?? {}
  const value = Number(map[file])
  if (Number.isFinite(value) && value > 0) return value
  const fallback = Number(DEFAULT_HALF_LIFE_DAYS[file])
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 60
}

/**
 * The non-rrf multiplier: decay × use boost. This is what the settings page
 * shows as 衰减分 — search results report the full combined score instead.
 */
export function decayScore({ meta, now, halfLifeDays, boost = DEFAULT_USE_BOOST } = {}) {
  const decay = decayFactor({
    age: ageDays(meta, now),
    halfLifeDays: halfLifeFor(meta?.file, halfLifeDays),
    pinned: isPinned(meta),
  })
  return decay * useFactor(meta?.useCount ?? 0, boost)
}

export function combineScore({ rrf, meta, now, halfLifeDays, boost = DEFAULT_USE_BOOST } = {}) {
  return (Number(rrf) || 0) * decayScore({ meta, now, halfLifeDays, boost })
}

/**
 * Re-rank retrieval hits by `rrf × decay × use boost`.
 * `metaById` maps bare entry id → meta row ({ file, lastUsedAt, createdAt, useCount, pinned }).
 * Hits without a meta row keep score = rrf (no invented freshness).
 */
export function rankHits(hits, metaById, { now, halfLifeDays, boost = DEFAULT_USE_BOOST, limit } = {}) {
  const lookup = metaById instanceof Map ? metaById : new Map(Object.entries(metaById ?? {}))
  const scored = (hits ?? []).map((hit) => {
    const meta = lookup.get(hit.id)
    const factor = decayScore({ meta, now, halfLifeDays, boost })
    return {
      ...hit,
      rrf: Number(hit.score) || 0,
      score: (Number(hit.score) || 0) * factor,
      decay: factor,
      pinned: isPinned(meta),
      useCount: meta ? (Number(meta.useCount) || 0) : 0,
      lastUsed: meta?.lastUsedAt ?? null,
    }
  })
  scored.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
  return Number.isFinite(limit) && limit >= 0 ? scored.slice(0, limit) : scored
}
