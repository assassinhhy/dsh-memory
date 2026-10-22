/**
 * Minimal hand-rolled line diff for tool results. No third-party dependency:
 * write ops echo back a short unified diff of the affected entry only, so the
 * model can see what changed without re-reading the file. Long diffs are
 * truncated with a note — the file stays the source of truth.
 */

const DEFAULT_MAX_LINES = 40

function splitLines(text) {
  const source = String(text ?? '')
  if (source === '') return []
  return source.replace(/\r\n?/g, '\n').split('\n')
}

/** LCS line diff. Returns [{ type: 'same'|'del'|'add', line }]. */
export function lineDiff(before, after) {
  const a = splitLines(before)
  const b = splitLines(after)
  const n = a.length
  const m = b.length
  const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', line: a[i] })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: 'del', line: a[i] })
      i += 1
    } else {
      ops.push({ type: 'add', line: b[j] })
      j += 1
    }
  }
  while (i < n) ops.push({ type: 'del', line: a[i++] })
  while (j < m) ops.push({ type: 'add', line: b[j++] })
  return ops
}

/**
 * Unified-diff text covering just the changed region plus `context` lines.
 * `startLine` is the 1-based line number of the region in its file. Returns ''
 * when the texts are equal.
 */
export function unifiedDiff(before, after, options = {}) {
  const { path = 'entry', startLine = 1, context = 2, maxLines = DEFAULT_MAX_LINES } = options
  const ops = lineDiff(before, after)
  if (!ops.some((op) => op.type !== 'same')) return ''

  const keep = new Array(ops.length).fill(false)
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type === 'same') continue
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true
  }

  const lines = [`--- a/${path}`, `+++ b/${path}`]
  let truncated = false
  let beforeSeen = 0
  let afterSeen = 0
  let i = 0
  while (i < ops.length) {
    if (!keep[i]) {
      if (ops[i].type !== 'add') beforeSeen += 1
      if (ops[i].type !== 'del') afterSeen += 1
      i += 1
      continue
    }
    let j = i
    let countBefore = 0
    let countAfter = 0
    while (j < ops.length && keep[j]) {
      if (ops[j].type !== 'add') countBefore += 1
      if (ops[j].type !== 'del') countAfter += 1
      j += 1
    }
    const from = countBefore === 0 ? 0 : startLine + beforeSeen
    const to = countAfter === 0 ? 0 : startLine + afterSeen
    lines.push(`@@ -${from},${countBefore} +${to},${countAfter} @@`)
    for (let k = i; k < j; k++) {
      if (lines.length >= maxLines) {
        truncated = true
        break
      }
      const op = ops[k]
      lines.push(op.type === 'same' ? ` ${op.line}` : op.type === 'del' ? `-${op.line}` : `+${op.line}`)
      if (op.type !== 'add') beforeSeen += 1
      if (op.type !== 'del') afterSeen += 1
    }
    if (truncated) break
    i = j
  }
  if (truncated) lines.push('…（diff 过长已截断，完整改动以文件为准）')
  return lines.join('\n')
}
