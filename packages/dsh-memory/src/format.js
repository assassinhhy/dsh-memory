/** Model-facing text for tool results. Expected refusals are ordinary strings, not throws. */
import { zonedDay } from './paths.js'

function when(ms) {
  const time = Number(ms)
  if (!Number.isFinite(time) || time <= 0) return 'never'
  return zonedDay(new Date(time), 'Asia/Shanghai')
}

export function formatWrite(result) {
  if (result.ok) {
    const used = result.limit == null ? '' : `（${result.used}/${result.limit} 字符）`
    return `已写入 ${result.target} id=${result.id}${used}`
  }
  return formatFailure(result)
}

export function formatRemove(result) {
  if (result.ok) return `已删除 ${result.target}${result.id ? ` id=${result.id}` : ''}`
  return formatFailure(result)
}

export function formatList(result) {
  if (result.ok === false) return formatFailure(result)
  if (result.files) {
    return result.files.map((file) => formatList(file)).join('\n\n')
  }
  const cap = result.limit == null ? '无上限' : `${result.used}/${result.limit}`
  const lines = [`${result.target} ${cap}`, `path: ${result.path}`]
  for (const entry of result.entries ?? []) {
    const preview = entry.text.replace(/\s+/g, ' ').trim().slice(0, 160)
    lines.push(`- ${entry.id} [${entry.kind}] ${entry.chars}字 ${entry.tags ? `tags=${entry.tags} ` : ''}${preview}`)
  }
  if ((result.entries ?? []).length === 0) lines.push('（空）')
  return lines.join('\n')
}

export function formatSearch(result) {
  if (!result.ok) return formatFailure(result)
  const head = result.vector
    ? `混合检索 ${result.hits.length} 条（FTS + 向量）`
    : `全文检索 ${result.hits.length} 条（向量未就绪：${result.vectorNote ?? '未加载'}）`
  if (result.hits.length === 0) return `${head}\n没有匹配。`
  const lines = [head]
  for (const hit of result.hits) {
    const via = Object.keys(hit.sources ?? {}).join('+') || 'fts'
    const id = String(hit.id).startsWith('p-') ? `${hit.id}（未标记正文，修改请用 anchor）` : hit.id
    const marks = [
      hit.pinned ? '📌' : '',
      `last_used=${when(hit.lastUsed)}`,
      `used=${Number(hit.useCount) || 0}`,
    ].filter(Boolean).join(' ')
    // score 是 rrf × 衰减 × 使用加成；rrf 保留原始融合分，方便判断是否过时。
    lines.push(`- ${id} [${hit.target}] via ${via} score=${hit.score.toFixed(4)} rrf=${(Number(hit.rrf) || 0).toFixed(4)} ${marks}\n  ${hit.text.replace(/\s+/g, ' ').trim().slice(0, 240)}`)
  }
  return lines.join('\n')
}

function formatFailure(result) {
  const lines = [result.error ?? '失败']
  if (result.suggestions?.length) {
    lines.push('可考虑合并或删除：')
    for (const item of result.suggestions) lines.push(`- ${item.id}（${item.chars} 字）${item.preview}`)
  }
  return lines.join('\n')
}
