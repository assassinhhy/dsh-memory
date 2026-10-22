/**
 * Reciprocal rank fusion. `lists` are already ranked best-first.
 * Score = Σ weight / (k + rank), rank starting at 1.
 */
export function rrfMerge(lists, { k = 60, limit = 8 } = {}) {
  const scores = new Map()
  for (const list of lists) {
    const weight = list.weight ?? 1
    list.items.forEach((item, index) => {
      const prev = scores.get(item.id) ?? { id: item.id, score: 0, sources: {} }
      const rank = index + 1
      prev.score += weight / (k + rank)
      prev.sources[list.source] = rank
      if (item.text !== undefined && prev.text === undefined) prev.text = item.text
      if (item.target !== undefined && prev.target === undefined) prev.target = item.target
      if (item.path !== undefined && prev.path === undefined) prev.path = item.path
      if (item.tags !== undefined && prev.tags === undefined) prev.tags = item.tags
      scores.set(item.id, prev)
    })
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit)
}

export function cosine(a, b) {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Quote a user query so FTS5 trigram treats it as a phrase, not as operators. */
export function ftsPhrase(query) {
  const cleaned = String(query).replace(/["*\u0000]/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned.length < 3) return undefined
  return `"${cleaned.replaceAll('"', '""')}"`
}
