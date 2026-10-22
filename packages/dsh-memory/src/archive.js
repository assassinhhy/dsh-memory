/**
 * Archive records. Archiving is never a hard delete: an entry moves out of its
 * Markdown file into memory/archive/YYYY-MM.md wrapped in a dsh-arch record that
 * remembers where it came from, so it can be restored byte-for-byte.
 *
 * <!-- dsh-arch id="e-1a2b3c4d" file="memory" from="MEMORY.md" at="2026-10-22 15:04:00" reason="stale" -->
 * <!-- dsh-mem id="e-1a2b3c4d" tags="tooling" -->
 * 记住我默认用 pnpm
 * <!-- /dsh-mem -->
 * <!-- /dsh-arch -->
 */
import { renderEntry } from './document.js'

export const ARCH_OPEN_RE = /^<!-- dsh-arch id="([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})" file="([^"]*)" from="([^"]*)" at="([^"]*)" reason="([^"]*)" -->$/
export const ARCH_CLOSE = '<!-- /dsh-arch -->'

function sanitize(value, fallback = '') {
  return String(value ?? fallback).replaceAll('"', "'").replaceAll('\n', ' ').trim()
}

export function renderArchiveRecord({ id, file, from, at, reason = '', tags = '', text }) {
  return [
    `<!-- dsh-arch id="${sanitize(id)}" file="${sanitize(file, 'memory')}" from="${sanitize(from)}" at="${sanitize(at)}" reason="${sanitize(reason)}" -->`,
    renderEntry({ id, tags, text }),
    ARCH_CLOSE,
  ].join('\n')
}

/**
 * @returns {Array<{ id: string, file: string, from: string, at: string, reason: string, tags: string, text: string, start: number, end: number }>}
 */
export function parseArchive(raw) {
  const text = String(raw ?? '')
  const lines = text.split(/\r?\n/)
  const records = []
  // Map line index → char offset so spans survive CRLF.
  const offsets = [0]
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1)
  for (let i = 0; i < lines.length; i++) {
    const opened = ARCH_OPEN_RE.exec(lines[i])
    if (!opened) continue
    let closedAt = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === ARCH_CLOSE) {
        closedAt = j
        break
      }
    }
    if (closedAt === -1) continue
    const inner = lines.slice(i + 1, closedAt).join('\n')
    const entry = /^\s*<!-- dsh-mem id="([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})" tags="([^"]*)" -->\r?\n?([\s\S]*?)\r?\n?<!-- \/dsh-mem -->\s*$/u.exec(inner)
    records.push({
      id: opened[1],
      file: opened[2],
      from: opened[3],
      at: opened[4],
      reason: opened[5],
      tags: entry ? entry[2] : '',
      text: entry ? entry[3].replaceAll('--&gt; dsh-mem', '<!-- /dsh-mem -->') : inner,
      start: offsets[i],
      // Span covers the open line through the close line, plus one trailing newline if present.
      end: Math.min(text.length, offsets[closedAt] + lines[closedAt].length + (text[offsets[closedAt] + lines[closedAt].length] === '\n' ? 1 : 0)),
    })
    i = closedAt
  }
  return records
}

export function findArchiveRecord(raw, id) {
  return parseArchive(raw).find((record) => record.id === id) ?? undefined
}

/** Drop one record (and its separating blank line) from an archive file. */
export function removeArchiveRecord(raw, id) {
  const record = findArchiveRecord(raw, id)
  if (!record) return undefined
  let start = record.start
  let end = record.end
  if (start > 0 && raw[start - 1] === '\n') {
    if (start < 2 || raw[start - 2] === '\n') start -= 1
  }
  return raw.slice(0, start) + raw.slice(end)
}

export function appendArchiveRecord(raw, record) {
  const block = renderArchiveRecord(record)
  const base = String(raw ?? '')
  if (base.length === 0) return `${block}\n`
  const sep = base.endsWith('\n') ? '\n' : '\n\n'
  return `${base}${sep}${block}\n`
}

/** archive/YYYY-MM.md in the given zone (default Asia/Shanghai). */
export function archiveFileName(month) {
  return `${month}.md`
}
