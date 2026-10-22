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
 *
 * M3 entry model: unmarked prose is not one blob any more. Each `- ` / `* ` /
 * `+ ` list line (plus its deeper-indented continuations and sub-items) is its
 * own entry with a stable content-hash id `l-…`; other prose splits on blank
 * lines into `p-…` blocks. Ids are content hashes, so adding / removing /
 * editing *other* entries never changes an entry's id. `unfenced` remains as a
 * legacy alias meaning "all prose as one region" (v0.1.0 semantics).
 */
import { createHash } from 'node:crypto'

const OPEN_RE = /^<!-- dsh-mem id="([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})" tags="([^"]*)" -->$/
export const CLOSE_MARK = '<!-- /dsh-mem -->'
export const SYNTHETIC_ID = 'unfenced'

/** Marker line: indent + `-`/`*`/`+` + spacing + content. `---` / `-foo` are not list items. */
const LIST_RE = /^([ \t]*)([-*+])([ \t]+)(.*)$/

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

/** Lines with exact byte offsets. `text` excludes its line terminator. */
function splitLines(raw) {
  const source = String(raw)
  const lines = []
  let start = 0
  for (let i = 0; i <= source.length; i++) {
    const ch = source[i]
    const atEnd = i === source.length
    const isEol = ch === '\n' || ch === '\r'
    if (!atEnd && !isEol) continue
    const text = source.slice(start, i)
    let end = i
    if (!atEnd) {
      if (ch === '\r' && source[i + 1] === '\n') end = i + 2
      else end = i + 1
    }
    lines.push({ text, start, end: i, eolEnd: end })
    if (atEnd) break
    i = end - 1
    start = end
  }
  return lines
}

function indentWidth(text) {
  const m = /^([ \t]*)/.exec(text)
  return m ? m[1].length : 0
}

/** Id body: strip a leading list marker, unify newlines, trim the ends. */
export function normalizeItemBody(text) {
  return stripMarker(String(text).replace(/\r\n?/g, '\n')).replace(/\r\n?/g, '\n').trim()
}

function hash10(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 10)
}

export function listId(body) {
  return `l-${hash10(normalizeItemBody(body))}`
}

export function proseId(body) {
  return `p-${hash10(normalizeItemBody(body))}`
}

/** Drop a leading `- ` / `* ` / `+ ` prefix from the first line only. */
export function stripMarker(text) {
  const source = String(text)
  const nl = source.indexOf('\n')
  const first = nl === -1 ? source : source.slice(0, nl)
  const rest = nl === -1 ? '' : source.slice(nl)
  const m = LIST_RE.exec(first)
  if (!m) return source
  return `${m[4]}${rest}`
}

/**
 * Render a list item's raw lines from its prefix and body. Continuation lines
 * that are not indented deeper than the marker are lifted to `indent + 2`
 * spaces so a multi-line replacement stays one item.
 */
export function renderItem(prefix, body) {
  const lines = String(body).replace(/\s+$/u, '').split('\n')
  const indent = /^([ \t]*)/.exec(prefix)?.[1] ?? ''
  const cont = `${indent}  `
  return lines
    .map((line, index) => {
      if (index === 0) return `${prefix}${line}`
      if (line.trim() === '') return line
      return indentWidth(line) > indent.length ? line : `${cont}${line}`
    })
    .join('\n')
}

/**
 * Split unmarked prose into entries. List lines (with deeper-indented
 * continuations / sub-items) become `kind: 'item'` entries; everything else is
 * split on blank lines into `kind: 'prose'` blocks. Offsets are relative to
 * `text` and cover the entry's own lines only (no trailing line terminator).
 *
 * `counter` (optional Map) carries duplicate numbering across prose segments of
 * one document: identical text gets `baseId` first, then `baseId~2`, `~3`…
 *
 * @returns {Array<{ kind: 'item'|'prose', text: string, body: string, start: number, end: number, prefix?: string, indent?: number }>}
 */
export function splitProse(text, counter) {
  const source = String(text)
  const lines = splitLines(source)
  const out = []
  const seen = counter ?? new Map()
  let prose = []
  let cur = undefined

  const flushProse = () => {
    if (prose.length === 0) return
    const first = prose[0]
    const last = prose[prose.length - 1]
    const slice = source.slice(first.start, last.end)
    out.push({
      kind: 'prose',
      text: slice,
      body: slice,
      start: first.start,
      end: last.end,
      id: numberedId(seen, proseId(slice)),
    })
    prose = []
  }

  const closeItem = () => {
    if (!cur) return
    out.push(cur)
    cur = undefined
  }

  const openItem = (line, m) => {
    flushProse()
    closeItem()
    cur = {
      kind: 'item',
      start: line.start,
      end: line.end,
      prefix: `${m[1]}${m[2]}${m[3]}`,
      indent: indentWidth(line.text),
      lines: [line],
    }
  }

  const extendItem = (line) => {
    cur.lines.push(line)
    cur.end = line.end
  }

  const finishItem = () => {
    if (!cur) return
    const slice = source.slice(cur.start, cur.end)
    const body = stripMarker(slice)
    out.push({
      kind: 'item',
      text: slice,
      body,
      start: cur.start,
      end: cur.end,
      prefix: cur.prefix,
      indent: cur.indent,
      id: numberedId(seen, listId(body)),
    })
    cur = undefined
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const blank = line.text.trim() === ''
    if (blank) {
      // A blank line ends the current item — unless the next non-blank line is
      // indented deeper, in which case the item continues (loose list).
      if (cur) {
        let j = i
        while (j < lines.length && lines[j].text.trim() === '') j++
        const next = lines[j]
        if (next && indentWidth(next.text) > cur.indent) {
          for (let k = i; k <= j && k < lines.length; k++) extendItem(lines[k])
          i = j
          continue
        }
        finishItem()
        continue
      }
      flushProse() // prose splits on blank lines
      continue
    }
    const m = LIST_RE.exec(line.text)
    if (m) {
      const indent = indentWidth(line.text)
      if (cur && indent > cur.indent) {
        extendItem(line) // sub-item / deeper continuation
        continue
      }
      finishItem()
      openItem(line, m)
      continue
    }
    if (cur && indentWidth(line.text) > cur.indent) {
      extendItem(line) // indented continuation
      continue
    }
    finishItem()
    prose.push(line)
  }
  finishItem()
  flushProse()
  return out
}

/** First occurrence keeps the plain id; later duplicates get `~2`, `~3`… */
function numberedId(seen, base) {
  const n = (seen.get(base) ?? 0) + 1
  seen.set(base, n)
  return n === 1 ? base : `${base}~${n}`
}

/**
 * @returns {Array<{ type: 'prose', text: string, start: number, end: number } |
 *   { type: 'entry', id: string, tags: string, text: string, start: number, end: number }>}
 */
export function parseDocument(raw) {
  const source = String(raw)
  const lines = splitLines(source)
  const segments = []
  let proseStart = -1
  let proseEnd = -1
  const flush = () => {
    if (proseStart === -1) return
    segments.push({ type: 'prose', text: source.slice(proseStart, proseEnd), start: proseStart, end: proseEnd })
    proseStart = -1
    proseEnd = -1
  }
  for (let i = 0; i < lines.length; i++) {
    const opened = OPEN_RE.exec(lines[i].text)
    if (!opened) {
      if (proseStart === -1) proseStart = lines[i].start
      proseEnd = lines[i].end
      continue
    }
    let closedAt = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].text === CLOSE_MARK) {
        closedAt = j
        break
      }
    }
    if (closedAt === -1) {
      if (proseStart === -1) proseStart = lines[i].start
      proseEnd = lines[i].end
      continue
    }
    flush()
    const body = []
    for (let j = i + 1; j < closedAt; j++) body.push(lines[j].text)
    segments.push({
      type: 'entry',
      id: opened[1],
      tags: opened[2],
      text: unescapeBody(body.join('\n')),
      start: lines[i].start,
      end: lines[closedAt].end,
    })
    i = closedAt
  }
  flush()
  return segments
}

/**
 * Every entry of a document with its byte span: marked `e-…` entries plus the
 * split `l-…` / `p-…` items. Document order. This is the single id source of
 * truth for list / search / meta.
 */
export function eachItem(raw) {
  const source = String(raw)
  const items = []
  const counter = new Map()
  for (const segment of parseDocument(source)) {
    if (segment.type === 'entry') {
      items.push({
        id: segment.id,
        kind: 'entry',
        tags: segment.tags,
        text: segment.text,
        body: segment.text,
        chars: segment.text.length,
        start: segment.start,
        end: segment.end,
      })
      continue
    }
    for (const part of splitProse(segment.text, counter)) {
      items.push({
        id: part.id,
        kind: part.kind,
        tags: '',
        text: part.text,
        body: part.body,
        chars: part.text.length,
        start: segment.start + part.start,
        end: segment.start + part.end,
        prefix: part.prefix,
        indent: part.indent,
      })
    }
  }
  return items
}

/** Display shape: no spans. Same ids as `eachItem`. */
export function listItems(raw) {
  return eachItem(raw).map(({ id, kind, tags, text, chars }) => ({ id, kind, tags, text, chars }))
}

/** v0.1.0 legacy: does this document still hold unmarked prose? */
export function hasUnfenced(raw) {
  return parseDocument(raw).some((segment) => segment.type === 'prose' && segment.text.trim() !== '')
}

/** Byte span of one marked entry, including its marker lines. */
export function findEntrySpan(raw, id) {
  const source = String(raw)
  const needle = `<!-- dsh-mem id="${id}" `
  let from = 0
  while (from < source.length) {
    const start = source.indexOf(needle, from)
    if (start === -1) return undefined
    if (start !== 0 && source[start - 1] !== '\n') {
      from = start + needle.length
      continue
    }
    const lineEndAt = source.indexOf('\n', start)
    const rawEnd = lineEndAt === -1 ? source.length : lineEndAt
    const openLine = source.slice(start, rawEnd).replace(/\r+$/u, '')
    if (!OPEN_RE.test(openLine)) {
      from = start + needle.length
      continue
    }
    const closeAt = source.indexOf(`\n${CLOSE_MARK}`, lineEndAt)
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

/** The exact bytes that take an item's place when it is rewritten. */
export function renderItemBlock(item, nextText) {
  const trimmed = String(nextText).trim()
  if (item?.kind !== 'item') return trimmed
  return renderItem(item.prefix, stripMarker(trimmed))
}

/** Splice new text into an `l-`/`p-` item's span. Every other byte is preserved. */
export function replaceItem(raw, item, nextText) {
  if (!item || typeof item.start !== 'number' || typeof item.end !== 'number') return undefined
  const block = renderItemBlock(item, nextText)
  if (block.trim() === '') return undefined
  return raw.slice(0, item.start) + block + raw.slice(item.end)
}

function eatEol(raw, i) {
  if (raw[i] === '\r' && raw[i + 1] === '\n') return i + 2
  if (raw[i] === '\n' || raw[i] === '\r') return i + 1
  return i
}

/** A blank line we can eat as separator: whitespace only, and it really ends. */
function blankLineEndingAt(raw, lineStartAt) {
  let end = lineStartAt
  while (end < raw.length && raw[end] !== '\n' && raw[end] !== '\r') {
    if (raw[end] !== ' ' && raw[end] !== '\t') return undefined
    end += 1
  }
  const after = eatEol(raw, end)
  if (after <= lineStartAt) return undefined
  return { start: lineStartAt, end: after }
}

/** Remove an `l-`/`p-` item's lines plus one blank-line separator, if any. */
export function removeItem(raw, item) {
  if (!item || typeof item.start !== 'number' || typeof item.end !== 'number') return undefined
  let start = item.start
  let end = eatEol(raw, item.end)
  const after = blankLineEndingAt(raw, end)
  if (after) {
    end = after.end
  } else if (start > 0 && String(raw).slice(end).trim() === '') {
    // Nothing but blanks after the item — drop the preceding separator too, so
    // a removed trailing entry does not leave a blank run behind.
    const beforeLine = lineStart(raw, start - 1)
    const before = blankLineEndingAt(raw, beforeLine)
    if (before && before.end === start) start = before.start
  }
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
    if (!OPEN_RE.test(line.replace(/\r+$/u, '')) && line !== CLOSE_MARK) spans.push({ start: at, end: at + needle.length })
    from = at + Math.max(needle.length, 1)
  }
  if (spans.length === 0) return undefined
  if (spans.length > 1) return 'ambiguous'
  return spans[0]
}

/** Items whose span intersects [from, to). */
export function itemsInRange(items, from, to) {
  return (items ?? []).filter((item) => item.start < to && item.end > from)
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

/** 1-based line number of a byte offset, for diff hunk headers. */
export function lineNumberAt(raw, index) {
  let line = 1
  for (let i = 0; i < index && i < raw.length; i++) if (raw[i] === '\n') line += 1
  return line
}
