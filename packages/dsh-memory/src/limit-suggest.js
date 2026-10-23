/**
 * Over-limit suggestions (CLAUDE_TASK_M3 C). Pure planning — nothing is ever
 * moved, merged or deleted automatically; the write is refused as a whole and
 * these hints ride along in the failure.
 *
 *   toJournal  one-off events / progress / date narratives → move to journal
 *   merge      highly similar pairs (trigram Jaccard) → merge into one
 *   trim       the longest leftovers
 *
 * Pinned entries are never suggested for moving. `use_count` / `last_used`
 * order the groups when meta is available: the longest-unused goes first.
 */

const JOURNAL_HINTS = [
  { re: /\d{4}-\d{2}-\d{2}/u, reason: '含日期，像一次性叙事' },
  { re: /\d{1,2}月\d{1,2}日/u, reason: '含日期，像一次性叙事' },
  { re: /今天|昨天|前天|刚才|刚刚|上周|本周|上个月|今晚|今早|这两天|那天/u, reason: '像今天/刚才发生的事' },
  { re: /已完成|完成|搞定|修好|已修|已解决|排查|踩坑|进度|临时|记录一下|上线|发布|测试通过/u, reason: '像进度/事件记录' },
]

const LONG_NARRATIVE = 100

function isPinned(row) {
  return row?.pinned === true || row?.pinned === 1 || row?.pinned === '1'
}

function previewOf(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 60)
}

function trigrams(text) {
  const norm = String(text ?? '').toLowerCase().replace(/\s+/g, '')
  const set = new Set()
  if (norm.length === 0) return set
  if (norm.length < 3) {
    set.add(norm)
    return set
  }
  for (let i = 0; i + 3 <= norm.length; i++) set.add(norm.slice(i, i + 3))
  return set
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const token of a) if (b.has(token)) inter += 1
  return inter / (a.size + b.size - inter)
}

/** Sort key: never-used first, then longest silence, then longest text. */
function byMovePriority(getMeta) {
  return (a, b) => {
    const ma = getMeta?.(a.id)
    const mb = getMeta?.(b.id)
    const lastA = Number(ma?.lastUsedAt) || 0
    const lastB = Number(mb?.lastUsedAt) || 0
    if (lastA !== lastB) return lastA - lastB
    return b.chars - a.chars
  }
}

/**
 * @param {Array<{id: string, kind: string, text: string, chars: number}>} items live items of the over-limit file
 * @param {object} options
 * @param {(id: string) => object} [options.getMeta] entry_meta row lookup (pin + usage signals)
 * @param {string[]} [options.excludeIds] ids of the entry being written — never suggest dropping it
 * @param {number} [options.incoming] chars this write would add
 * @param {number} [options.limit] file cap
 * @param {number} [options.used] chars the over-limit candidate would reach
 * @returns {{toJournal: object[], merge: object[], trim: object[], incoming: number, overflow: number, freed: number, enough: boolean}}
 */
export function suggestForLimit(items, options = {}) {
  const {
    getMeta,
    excludeIds = [],
    incoming = 0,
    limit = 0,
    used = 0,
    maxPerGroup = 3,
  } = options
  const excluded = new Set(excludeIds.map(String))
  const candidates = (items ?? []).filter((item) => {
    if (!item?.id || excluded.has(String(item.id))) return false
    return !isPinned(getMeta?.(item.id))
  })
  const order = byMovePriority(getMeta)

  const toJournal = []
  for (const item of [...candidates].sort(order)) {
    if (toJournal.length >= maxPerGroup) break
    const hit = JOURNAL_HINTS.find((hint) => hint.re.test(item.text))
    const longwinded = item.chars >= LONG_NARRATIVE
    if (!hit && !longwinded) continue
    toJournal.push({
      id: item.id,
      chars: item.chars,
      preview: previewOf(item.text),
      reason: hit ? hit.reason : '很长的叙述，细节适合放日记',
    })
  }

  // merge: similar pairs among what is left (trigram Jaccard).
  const journalIds = new Set(toJournal.map((item) => item.id))
  const pool = candidates.filter((item) => !journalIds.has(item.id))
  const merge = []
  const mergedAway = new Set()
  for (let i = 0; i < pool.length; i++) {
    if (merge.length >= maxPerGroup) break
    for (let j = i + 1; j < pool.length; j++) {
      if (merge.length >= maxPerGroup) break
      const a = pool[i]
      const b = pool[j]
      if (mergedAway.has(a.id) || mergedAway.has(b.id)) continue
      const score = jaccard(trigrams(a.text), trigrams(b.text))
      if (score < 0.3) continue
      const [keep, drop] = a.chars >= b.chars ? [a, b] : [b, a]
      mergedAway.add(drop.id)
      merge.push({
        ids: [keep.id, drop.id],
        chars: drop.chars,
        preview: `${previewOf(keep.text)} / ${previewOf(drop.text)}`,
        reason: `内容相似度 ${score.toFixed(2)}，可合并成一条`,
        similarity: Number(score.toFixed(2)),
      })
    }
  }

  // trim: the longest leftovers — length first, longest-unused first on ties.
  // Both sides of a merge pair are skipped: the pair already covers them.
  const touched = new Set(mergedAway)
  for (const pair of merge) for (const id of pair.ids) touched.add(id)
  const trim = pool
    .filter((item) => !touched.has(item.id))
    .sort((a, b) => b.chars - a.chars || order(a, b))
    .slice(0, maxPerGroup)
    .map((item) => ({
      id: item.id,
      chars: item.chars,
      preview: previewOf(item.text),
      reason: '占字最多的条目之一，可精简',
    }))

  const drops = new Set()
  let freed = 0
  for (const group of [toJournal, trim]) {
    for (const item of group) {
      if (drops.has(item.id)) continue
      drops.add(item.id)
      freed += item.chars
    }
  }
  for (const pair of merge) {
    const dropId = pair.ids[1]
    if (drops.has(dropId)) continue
    drops.add(dropId)
    freed += pair.chars
  }

  return {
    toJournal,
    merge,
    trim,
    incoming: Math.max(0, Math.round(incoming)),
    overflow: Math.max(0, Math.round(used - limit)),
    freed,
    enough: freed >= Math.max(0, Math.round(incoming)),
  }
}
