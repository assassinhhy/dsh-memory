/**
 * USER.md / MEMORY.md stay human markdown. Tool-written entries are wrapped in
 * HTML comment markers so a hand edit of the surrounding prose is still valid,
 * and so we never rewrite a seed file just to give it ids.
 *
 *   <!-- dsh-mem id="e-1a2b3c4d" tags="preference" -->
 *   记住我默认用 pnpm
 *   <!-- /dsh-mem -->
 *
 * Markers must be whole lines. A body line that would collide with the closer
 * is escaped; everything else is stored as the user typed it.
 */

const OPEN_RE = /^<!-- dsh-mem id="([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})" tags="([^"]*)" -->$/
export const CLOSE_MARK = '<!-- /dsh-mem -->'
const SYNTHETIC_ID = 'unfenced'

export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(/[,，\s]+/)
  const clean = []
  for (const tag of list) {
    const trimmed = String(tag).trim().replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 32)
    if (trimmed !== '' && !clean.includes(trimmed)) clean.push(trimmed)
    if (clean.length >= 8) break
  }
  return clean.join(',')
}

export function escapeBody(text) {
  return String(text).replaceAll(CLOSE_MARK, '--&gt; dsh-mem')
}

export function unescapeBody(text) {
  return String(text).replaceAll('--&gt; dsh-mem', CLOSE_MARK)
}

export function renderEntry({ id, tags = '', text }) {
  const body = escapeBody(String(text).replace(/\s+$/u, ''))
  return `<!-- dsh-mem id="${id}" tags="${normalizeTags(tags)}" -->\n${body}\n${CLOSE_MARK}`
}

function splitLines(raw) {
  return String(raw).split(/\r?\n/)
}

/**
 * @returns {Array<{ type: 'prose', text: string } | { type: 'entry', id: string, tags: string, text: string }>}
 */
export function parseDocument(raw) {
  const lines = splitLines(raw)
  const segments = []
  let prose = []
  const flush = () => {
    if (prose.length === 0) return
    segments.push({ type: 'prose', text: prose.join('\n') })
    prose = []
  }
  for (let i = 0; i < lines.length; i++) {
    const opened = OPEN_RE.exec(lines[i])
    if (!opened) {
      prose.push(lines[i])
      continue
    }
    const body = []
    let closedAt = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === CLOSE_MARK) {
        closedAt = j
        break
      }
      body.push(lines[j])
    }
    if (closedAt === -1) {
      prose.push(lines[i])
      continue
    }
    flush()
    segments.push({
      type: 'entry',
      id: opened[1],
      tags: opened[2],
      text: unescapeBody(body.join('\n')),
    })
    i = closedAt
  }
  flush()
  return segments
}

export function listItems(raw) {
  const items = []
  const prose = []
  for (const segment of parseDocument(raw)) {
    if (segment.type === 'entry') {
      items.push({
        id: segment.id,
        kind: 'entry',
        tags: segment.tags,
        text: segment.text,
        chars: segment.text.length,
      })
    } else if (segment.text.trim() !== '') {
      prose.push(segment.text)
    }
  }
  if (prose.length > 0 && !items.some((item) => item.id === SYNTHETIC_ID)) {
    const text = prose.join('\n')
    items.unshift({
      id: SYNTHETIC_ID,
      kind: 'prose',
      tags: '',
      text,
      chars: text.length,
    })
  }
  return items
}

/** Byte span of one marked entry, including its marker lines. */
export function findEntrySpan(raw, id) {
  const needle = `<!-- dsh-mem id="${id}" `
  let from = 0
  while (from < raw.length) {
    const start = raw.indexOf(needle, from)
    if (start === -1) return undefined
    if (start !== 0 && raw[start - 1] !== '\n') {
      from = start + needle.length
      continue
    }
    const lineEndAt = raw.indexOf('\n', start)
    if (lineEndAt === -1) return undefined
    const openLine = raw.slice(start, lineEndAt)
    if (!OPEN_RE.test(openLine)) {
      from = start + needle.length
      continue
    }
    const closeAt = raw.indexOf(`\n${CLOSE_MARK}`, lineEndAt)
    if (closeAt === -1) return undefined
    const end = closeAt + 1 + CLOSE_MARK.length
    const tags = OPEN_RE.exec(openLine)?.[2] ?? ''
    return { start, end, tags, bodyStart: lineEndAt + 1, bodyEnd: closeAt }
  }
  return undefined
}

function lineStart(raw, index) {
  const prev = raw.lastIndexOf('\n', index - 1)
  return prev === -1 ? 0 : prev + 1
}

function lineEnd(raw, index) {
  const next = raw.indexOf('\n', index)
  return next === -1 ? raw.length : next
}

export function appendEntry(raw, entry) {
  const block = renderEntry(entry)
  if (raw.length === 0) return `${block}\n`
  const sep = raw.endsWith('\n') ? '\n' : '\n\n'
  return `${raw}${sep}${block}\n`
}

export function replaceMarked(raw, id, { text, tags }) {
  const span = findEntrySpan(raw, id)
  if (!span) return undefined
  const nextTags = tags === undefined ? span.tags : normalizeTags(tags)
  const block = renderEntry({ id, tags: nextTags, text })
  return raw.slice(0, span.start) + block + raw.slice(span.end)
}

export function removeMarked(raw, id) {
  const span = findEntrySpan(raw, id)
  if (!span) return undefined
  let start = span.start
  let end = span.end
  if (raw[end] === '\n') end += 1
  if (start > 0 && raw[start - 1] === '\n' && (start < 2 || raw[start - 2] === '\n')) start -= 1
  return raw.slice(0, start) + raw.slice(end)
}

/** Replace every unfenced region with `text`, keeping marked entries after it. */
export function replaceUnfenced(raw, text) {
  const entries = parseDocument(raw).filter((segment) => segment.type === 'entry')
  const prose = String(text).replace(/\s+$/u, '')
  const blocks = entries.map((entry) => renderEntry(entry)).join('\n\n')
  if (prose === '' && blocks === '') return ''
  if (prose === '') return `${blocks}\n`
  if (blocks === '') return `${prose}\n`
  return `${prose}\n\n${blocks}\n`
}

export function removeUnfenced(raw) {
  return replaceUnfenced(raw, '')
}

/**
 * Unique substring match. Returns the span, 'ambiguous', or undefined.
 * Does not match inside marker lines.
 */
export function findAnchor(raw, anchor) {
  const needle = String(anchor ?? '')
  if (needle.trim() === '') return undefined
  const spans = []
  let from = 0
  while (from < raw.length) {
    const at = raw.indexOf(needle, from)
    if (at === -1) break
    const start = lineStart(raw, at)
    const end = lineEnd(raw, at)
    const line = raw.slice(start, end)
    if (!OPEN_RE.test(line) && line !== CLOSE_MARK) spans.push({ start: at, end: at + needle.length })
    from = at + Math.max(needle.length, 1)
  }
  if (spans.length === 0) return undefined
  if (spans.length > 1) return 'ambiguous'
  return spans[0]
}

export function replaceAnchor(raw, anchor, text) {
  const found = findAnchor(raw, anchor)
  if (found === undefined || found === 'ambiguous') return found
  return raw.slice(0, found.start) + text + raw.slice(found.end)
}

export function removeAnchor(raw, anchor) {
  const found = findAnchor(raw, anchor)
  if (found === undefined || found === 'ambiguous') return found
  let start = found.start
  let end = found.end
  const lineFrom = lineStart(raw, start)
  const lineTo = lineEnd(raw, start)
  const line = raw.slice(lineFrom, lineTo)
  if (line.trim() === anchor.trim()) {
    start = lineFrom
    end = lineTo
    if (raw[end] === '\n') end += 1
  }
  return raw.slice(0, start) + raw.slice(end)
}

export function longestEntries(items, count = 3) {
  return [...items]
    .filter((item) => item.kind === 'entry' || item.id === SYNTHETIC_ID)
    .sort((a, b) => b.chars - a.chars)
    .slice(0, count)
    .map((item) => ({
      id: item.id,
      chars: item.chars,
      preview: item.text.replace(/\s+/g, ' ').trim().slice(0, 80),
    }))
}
