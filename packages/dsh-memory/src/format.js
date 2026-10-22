/**
 * Model-facing text for tool results. Expected refusals are ordinary strings,
 * not throws. M3: every write echoes the id chain (旧→新), the char usage, and
 * a short unified diff of the affected entry only; over-limit failures lay out
 * the toJournal / merge / trim suggestions with an estimate instead of a bare
 * "go delete something".
 */
import { keyFactLabel } from './keyfact.js'
import { zonedDay } from './paths.js'

function when(ms) {
  const time = Number(ms)
  if (!Number.isFinite(time) || time <= 0) return 'never'
  return zonedDay(new Date(time), 'Asia/Shanghai')
}

function usageText(result) {
  return result.limit == null ? '' : `（${result.used}/${result.limit} 字符）`
}

/** `id=新` on add, `id=旧 → 新` when replace rewrote a content-hash id. */
function idText(result) {
  if (result.previousId && result.previousId !== result.id) return `id=${result.previousId} → ${result.id}`
  return `id=${result.id}`
}

function diffText(result) {
  const diff = result.diff?.text
  return diff ? `\n${diff}` : ''
}

export function formatWrite(result) {
  if (!result.ok) return formatFailure(result)
  const verb = result.previousId && result.previousId !== result.id ? '已更新' : '已写入'
  const lines = [`${verb} ${result.target} ${idText(result)}${usageText(result)}`]
  if ((result.affectedIds ?? []).length > 1) lines.push(`affected: ${result.affectedIds.join(', ')}`)
  if (result.suggestPin) {
    const kinds = keyFactLabel(result.suggestPin.kinds)
    lines.push(`💡 像是稳定关键事实（${kinds}），建议 memory_pin id=${result.suggestPin.id}`)
  }
  return lines.join('\n') + diffText(result)
}

export function formatRemove(result) {
  if (!result.ok) return formatFailure(result)
  const lines = [`已删除 ${result.target} id=${result.id}${usageText(result)}`]
  if ((result.affectedIds ?? []).length > 1) lines.push(`affected: ${result.affectedIds.join(', ')}`)
  return lines.join('\n') + diffText(result)
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
    const pin = entry.pinned ? ' 📌' : ''
    lines.push(`- ${entry.id} [${entry.kind}] ${entry.chars}字${pin} ${entry.tags ? `tags=${entry.tags} ` : ''}${preview}`)
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
    const id = hit.id
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

function suggestionLine(item) {
  return `- ${item.id}（${item.chars} 字）${item.preview} — ${item.reason}`
}

export function formatFailure(result) {
  const lines = [result.error ?? '失败']
  const groups = result.suggestions
  if (!groups || Array.isArray(groups)) {
    if (groups?.length) {
      lines.push('可考虑合并或删除：')
      for (const item of groups) lines.push(`- ${item.id}（${item.chars} 字）${item.preview}`)
    }
    return lines.join('\n')
  }
  const { toJournal = [], merge = [], trim = [], incoming = 0, freed = 0, enough = false } = groups
  if (toJournal.length === 0 && merge.length === 0 && trim.length === 0) {
    lines.push('文件里已没有可自动建议的条目（可能都已置顶）。请手动处理后再写。')
    return lines.join('\n')
  }
  if (toJournal.length > 0) {
    lines.push('可挪去日记（一次性事件/进度/日期叙事）：')
    for (const item of toJournal) lines.push(suggestionLine(item))
  }
  if (merge.length > 0) {
    lines.push('可合并的相似条目（保留长的那条）：')
    for (const item of merge) {
      lines.push(`- ${item.ids[0]} + ${item.ids[1]}（${item.chars} 字）${item.preview} — ${item.reason}`)
    }
  }
  if (trim.length > 0) {
    lines.push('可精简的长条目：')
    for (const item of trim) lines.push(suggestionLine(item))
  }
  const need = Math.max(0, Math.round(incoming))
  if (need > 0) {
    lines.push(enough
      ? `挪走这些后可释放约 ${freed} 字，足以写入本次 ${need} 字。`
      : `挪走这些后可释放约 ${freed} 字，仍不够本次 ${need} 字（还差 ${need - freed} 字）。`)
  } else {
    lines.push(`挪走这些后可释放约 ${freed} 字。`)
  }
  lines.push('以上只是建议，不会自动删除/合并/挪动；也不会截断写入。确认后请手动 memory_remove / memory_replace。')
  return lines.join('\n')
}
