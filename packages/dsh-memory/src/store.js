/**
 * Markdown memory store. Reads and writes only files under the memory root
 * (USER.md, MEMORY.md, journal/YYYY-MM-DD.md). Never creates or rewrites
 * AGENTS.md. Seed prose is left byte-for-byte intact until a tool explicitly
 * edits that region.
 *
 * M3: every list line / prose block is an addressable entry (`l-…` / `p-…`
 * content-hash ids). replace / remove work on those ids and keep every other
 * byte unchanged; results carry the affected ids, id renames (for entry_meta
 * migration) and a short unified diff. The legacy `unfenced` id still rewrites
 * all prose as one region (v0.1.0 semantics).
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { appendArchiveRecord, findArchiveRecord, parseArchive, removeArchiveRecord } from './archive.js'
import { unifiedDiff } from './diff.js'
import {
  SYNTHETIC_ID,
  appendEntry,
  eachItem,
  findAnchor,
  findEntrySpan,
  hasUnfenced,
  itemsInRange,
  lineNumberAt,
  listItems,
  normalizeTags,
  removeAnchor,
  removeItem,
  removeMarked,
  removeUnfenced,
  replaceAnchor,
  replaceItem,
  replaceMarked,
  replaceUnfenced,
  renderItemBlock,
} from './document.js'
import { suggestForLimit } from './limit-suggest.js'
import { LIMITS, charLength, fileFor, zonedDay, zonedMonth, zonedStamp } from './paths.js'
import { scanSecrets, secretError } from './redact.js'

const RESIDENT = new Set(['user', 'memory'])

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

async function readOrEmpty(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra }
}

function makeDiff(regionBefore, regionAfter, { path, startLine = 1 } = {}) {
  return {
    before: regionBefore ?? '',
    after: regionAfter ?? '',
    text: unifiedDiff(regionBefore ?? '', regionAfter ?? '', { path, startLine, context: 2 }),
  }
}

function overlaps(item, region) {
  if (!region) return false
  return item.start < region.end && item.end > region.start
}

/**
 * Pair items across one rewrite: the rewritten region's old/new items, plus
 * survivors outside the region (their ids shift only when duplicate numbering
 * moves). `renames` come back in document order so meta migration can free an
 * id before anything else moves into it.
 */
function analyzeRewrite(beforeItems, afterItems, oldRegion, newRegion) {
  const oldHit = (beforeItems ?? []).filter((item) => overlaps(item, oldRegion))
  const newHit = (afterItems ?? []).filter((item) => overlaps(item, newRegion))
  const survivors = (beforeItems ?? []).filter((item) => !overlaps(item, oldRegion))
  const afterSurvivors = (afterItems ?? []).filter((item) => !overlaps(item, newRegion))
  const renames = []
  if (oldHit.length === newHit.length) {
    for (let i = 0; i < oldHit.length; i++) {
      if (oldHit[i].id !== newHit[i].id) renames.push([oldHit[i].id, newHit[i].id])
    }
  }
  if (survivors.length === afterSurvivors.length) {
    for (let i = 0; i < survivors.length; i++) {
      if (survivors[i].id !== afterSurvivors[i].id) renames.push([survivors[i].id, afterSurvivors[i].id])
    }
  }
  return { oldHit, newHit, renames }
}

export function createStore(options = {}) {
  if (!options.root) throw new Error('createStore requires root (refusing to default inside tests/tools)')
  const root = options.root
  const now = options.now ?? (() => new Date())
  const tz = options.tz ?? 'Asia/Shanghai'
  const idFactory = options.idFactory ?? (() => `e-${randomBytes(4).toString('hex')}`)
  const getMeta = typeof options.getMeta === 'function' ? options.getMeta : undefined
  let chain = Promise.resolve()

  const locked = (fn) => {
    const run = chain.then(fn, fn)
    chain = run.then(() => {}, () => {})
    return run
  }

  const residentPath = (target) => {
    if (!RESIDENT.has(target)) throw new Error(`not a resident target: ${target}`)
    return fileFor(root, target)
  }

  const journalFile = (day) => join(root, 'journal', `${day}.md`)

  const archiveDir = () => join(root, 'archive')

  function relPath(path) {
    return String(path ?? '').slice(root.length + 1).replaceAll('\\', '/')
  }

  async function archiveFiles() {
    let names = []
    try {
      names = await readdir(archiveDir())
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    return names
      .filter((name) => /^\d{4}-\d{2}\.md$/u.test(name))
      .sort()
      .map((name) => join(archiveDir(), name))
  }

  /** Only paths that look like a memory file under root. */
  function safeRestorePath(from, file, at) {
    const norm = String(from ?? '').replaceAll('\\', '/')
    if (!norm.includes('..')) {
      if (/^(USER|MEMORY)\.md$/u.test(norm)) return join(root, norm)
      if (/^journal\/\d{4}-\d{2}-\d{2}\.md$/u.test(norm)) return join(root, ...norm.split('/'))
    }
    if (file === 'user' || file === 'memory') return fileFor(root, file)
    const day = /^\d{4}-\d{2}-\d{2}/u.exec(String(at ?? ''))?.[0]
    return day ? journalFile(day) : undefined
  }

  async function journalPaths() {
    const dir = fileFor(root, 'journal')
    let names = []
    try {
      names = await readdir(dir)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    return names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name))
      .sort()
      .map((name) => join(dir, name))
  }

  function usageOf(target, text) {
    const limit = LIMITS[target] ?? null
    return { used: charLength(text), limit }
  }

  function overLimit(target, next, current, excludeIds) {
    const limit = LIMITS[target]
    if (limit === undefined) return undefined
    const used = charLength(next)
    if (used <= limit) return undefined
    const suggestions = suggestForLimit(listItems(next), {
      getMeta,
      excludeIds: excludeIds ?? [],
      incoming: Math.max(0, used - charLength(current ?? '')),
      limit,
      used,
    })
    return fail('over_limit',
      `${target === 'user' ? 'USER.md' : 'MEMORY.md'} 写入后将达到 ${used} 字符，上限 ${limit}。已拒绝写入，没有截断。请先按下面的建议腾出空间（只建议，不会自动执行）。`,
      { ...usageOf(target, current ?? next), suggestions })
  }

  function rejectSecret(text) {
    const scanned = scanSecrets(text)
    if (scanned.ok) return undefined
    return fail('secret', secretError(scanned.kinds), { kinds: scanned.kinds })
  }

  async function readResident(target) {
    const path = residentPath(target)
    const text = await readOrEmpty(path)
    return { target, path, text, ...usageOf(target, text), entries: listItems(text) }
  }

  /** First file with prose wins for the legacy `unfenced` id (v0.1.0 order). */
  async function locateEntry(id) {
    const hits = []
    const scan = (target, path, text, allowUnfenced) => {
      if (id === SYNTHETIC_ID) {
        if (allowUnfenced && hasUnfenced(text)) hits.push({ target, path, text, where: 'unfenced' })
        return
      }
      if (text.includes(`<!-- dsh-mem id="${id}" `)) {
        hits.push({ target, path, text, where: 'entry' })
        return
      }
      const item = eachItem(text).find((entry) => entry.id === id)
      if (item) hits.push({ target, path, text, where: 'item', item })
    }
    for (const target of ['user', 'memory']) {
      const path = residentPath(target)
      scan(target, path, await readOrEmpty(path), true)
    }
    for (const path of await journalPaths()) {
      scan('journal', path, await readOrEmpty(path), false)
    }
    if (id === SYNTHETIC_ID) return hits[0]
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return 'ambiguous'
    return undefined
  }

  async function locateAnchor(anchor) {
    const hits = []
    const consider = async (target, path, text) => {
      const found = findAnchor(text, anchor)
      if (found && found !== 'ambiguous') hits.push({ target, path, text })
      if (found === 'ambiguous') hits.push({ target, path, text, ambiguous: true })
    }
    for (const target of ['user', 'memory']) {
      const path = residentPath(target)
      await consider(target, path, await readOrEmpty(path))
    }
    for (const path of await journalPaths()) {
      await consider('journal', path, await readOrEmpty(path))
    }
    const exact = hits.filter((hit) => !hit.ambiguous)
    if (exact.length === 1) return exact[0]
    if (exact.length > 1 || hits.some((hit) => hit.ambiguous)) return 'ambiguous'
    return undefined
  }

  /** Whole rewrite of one item / one region: ids, renames and the diff. */
  function planReplace(located, { id, anchor, body, tags }) {
    const before = located.text
    const path = relPath(located.path)
    const beforeItems = eachItem(before)

    if (located.where === 'unfenced') {
      if (body === undefined) return { error: fail('empty', '修改未标记正文需要提供 text') }
      const newProse = body.trim()
      const next = replaceUnfenced(before, newProse)
      const oldProse = beforeItems.filter((item) => item.kind !== 'entry')
      const newProseItems = eachItem(next).filter((item) => item.kind !== 'entry')
      const renames = oldProse.length === newProseItems.length
        ? oldProse.map((item, i) => [item.id, newProseItems[i].id]).filter(([from, to]) => from !== to)
        : []
      return {
        next,
        id: SYNTHETIC_ID,
        affectedIds: newProseItems.map((item) => item.id),
        renames,
        entry: newProseItems[0],
        diff: makeDiff(oldProse.map((item) => item.text).join('\n\n'), newProse, { path, startLine: 1 }),
      }
    }

    if (located.where === 'entry') {
      if (body === undefined && tags === undefined) return { error: fail('empty', '修改条目需要提供 text 或 tags') }
      const item = beforeItems.find((entry) => entry.id === id) ?? findEntrySpan(before, id)
      const oldText = item?.text ?? ''
      const newText = body === undefined ? oldText : body.trim()
      const next = replaceMarked(before, id, { text: newText, tags })
      if (next === undefined) return { error: fail('not_found', '没有找到要修改的条目。') }
      const afterItem = eachItem(next).find((entry) => entry.id === id)
      return {
        next,
        id,
        affectedIds: [id],
        renames: [],
        entry: afterItem,
        diff: makeDiff(oldText, afterItem?.text ?? newText, {
          path,
          startLine: item?.start === undefined ? 1 : lineNumberAt(before, item.start),
        }),
      }
    }

    if (located.where === 'item') {
      if (body === undefined) return { error: fail('empty', '修改条目需要提供 text') }
      const item = located.item
      const block = renderItemBlock(item, body)
      if (block.trim() === '') return { error: fail('empty', 'text 不能为空') }
      const next = replaceItem(before, item, body)
      if (next === undefined) return { error: fail('empty', 'text 不能为空') }
      const newRegion = { start: item.start, end: item.start + block.length }
      const { oldHit, newHit, renames } = analyzeRewrite(beforeItems, eachItem(next), item, newRegion)
      const primary = newHit[0]
      if (!primary) return { error: fail('not_found', '没有找到要修改的条目。') }
      return {
        next,
        id: primary.id,
        previousId: item.id,
        affectedIds: newHit.map((entry) => entry.id),
        renames,
        entry: primary,
        diff: makeDiff(oldHit.map((entry) => entry.text).join('\n') ?? item.text, newHit.map((entry) => entry.text).join('\n'), {
          path,
          startLine: lineNumberAt(before, item.start),
        }),
      }
    }

    // anchor path — v0.1.0 substring splice, now resolved to the entry it sits in
    if (body === undefined) return { error: fail('empty', '按锚点修改需要提供 text') }
    const span = findAnchor(before, anchor)
    if (span === 'ambiguous') return { error: fail('ambiguous', '锚点匹配到多处。请改用 id。') }
    if (span === undefined) return { error: fail('not_found', '没有找到要修改的条目。') }
    const newBody = body.trim()
    const next = replaceAnchor(before, anchor, newBody)
    if (next === 'ambiguous') return { error: fail('ambiguous', '锚点匹配到多处。请改用 id。') }
    if (next === undefined) return { error: fail('not_found', '没有找到要修改的条目。') }
    const oldRegion = { start: span.start, end: span.end }
    const newRegion = { start: span.start, end: span.start + newBody.length }
    const { oldHit, newHit, renames } = analyzeRewrite(beforeItems, eachItem(next), oldRegion, newRegion)
    const primary = newHit[0]
    const previousId = oldHit[0]?.id
    const primaryId = primary?.id ?? previousId
    if (!primaryId) return { error: fail('not_found', '没有找到要修改的条目。') }
    return {
      next,
      id: primaryId,
      previousId,
      affectedIds: (newHit.length > 0 ? newHit : oldHit).map((entry) => entry.id),
      renames,
      entry: primary,
      diff: makeDiff(
        oldHit.length > 0 ? oldHit.map((entry) => entry.text).join('\n') : before.slice(oldRegion.start, oldRegion.end),
        newHit.length > 0 ? newHit.map((entry) => entry.text).join('\n') : newBody,
        { path, startLine: lineNumberAt(before, span.start) },
      ),
    }
  }

  /** Removal counterpart of planReplace: ids, renumber renames, diff. */
  function planRemove(located, { id, anchor }) {
    const before = located.text
    const path = relPath(located.path)
    const beforeItems = eachItem(before)

    if (located.where === 'unfenced' || id === SYNTHETIC_ID) {
      const oldProse = beforeItems.filter((item) => item.kind !== 'entry')
      const next = removeUnfenced(before)
      return {
        next,
        id: SYNTHETIC_ID,
        affectedIds: oldProse.map((item) => item.id),
        removedIds: oldProse.map((item) => item.id),
        renames: [],
        entry: oldProse[0],
        diff: makeDiff(oldProse.map((item) => item.text).join('\n\n'), '', { path, startLine: 1 }),
      }
    }

    if (id && located.where === 'entry') {
      const item = beforeItems.find((entry) => entry.id === id)
      const next = removeMarked(before, id)
      if (next === undefined) return { error: fail('not_found', '没有找到要删除的条目。') }
      return {
        next,
        id,
        affectedIds: [id],
        removedIds: [id],
        renames: [],
        entry: item,
        diff: makeDiff(item?.text ?? '', '', { path, startLine: item ? lineNumberAt(before, item.start) : 1 }),
      }
    }

    if (id && located.where === 'item') {
      const item = located.item
      const next = removeItem(before, item)
      if (next === undefined) return { error: fail('not_found', '没有找到要删除的条目。') }
      const afterItems = eachItem(next)
      const { renames } = analyzeRewrite(beforeItems, afterItems, item, { start: item.start, end: item.start })
      const appeared = afterItems.map((entry) => entry.id).filter((entryId) => !beforeItems.some((entry) => entry.id === entryId))
      return {
        next,
        id,
        affectedIds: [id, ...appeared],
        removedIds: [id],
        renames,
        entry: item,
        diff: makeDiff(item.text, '', { path, startLine: lineNumberAt(before, item.start) }),
      }
    }

    // anchor path
    const span = findAnchor(before, anchor)
    if (span === 'ambiguous') return { error: fail('ambiguous', '锚点匹配到多处。请改用 id。') }
    if (span === undefined) return { error: fail('not_found', '没有找到要删除的条目。') }
    const next = removeAnchor(before, anchor)
    if (next === 'ambiguous') return { error: fail('ambiguous', '锚点匹配到多处。请改用 id。') }
    if (next === undefined) return { error: fail('not_found', '没有找到要删除的条目。') }
    const oldRegion = { start: span.start, end: span.end }
    const { oldHit, renames } = analyzeRewrite(beforeItems, eachItem(next), oldRegion, { start: span.start, end: span.start })
    const primary = oldHit[0]
    if (!primary) return { error: fail('not_found', '没有找到要删除的条目。') }
    const afterItems = eachItem(next)
    const afterIds = new Set(afterItems.map((entry) => entry.id))
    const appeared = afterItems.map((entry) => entry.id).filter((entryId) => !beforeItems.some((entry) => entry.id === entryId))
    return {
      next,
      id: primary.id,
      affectedIds: [primary.id, ...appeared],
      removedIds: oldHit.map((entry) => entry.id).filter((entryId) => !afterIds.has(entryId)),
      renames,
      entry: primary,
      diff: makeDiff(oldHit.map((entry) => entry.text).join('\n'), '', {
        path,
        startLine: lineNumberAt(before, span.start),
      }),
    }
  }

  return {
    root,
    pathFor(target) {
      return fileFor(root, target)
    },

    async read(target) {
      if (target === 'journal') {
        const files = []
        for (const path of await journalPaths()) {
          files.push({ path, text: await readOrEmpty(path) })
        }
        return { target, files }
      }
      return readResident(target)
    },

    async list(target) {
      if (target !== undefined && target !== 'user' && target !== 'memory' && target !== 'journal') {
        return fail('bad_target', 'target 只能是 user、memory 或 journal')
      }
      if (target === 'journal') {
        const entries = []
        for (const path of await journalPaths()) {
          const text = await readOrEmpty(path)
          for (const item of listItems(text)) entries.push({ ...item, path })
        }
        return { ok: true, target, used: null, limit: null, entries }
      }
      const targets = target === undefined ? ['user', 'memory'] : [target]
      const files = []
      for (const name of targets) files.push({ ok: true, ...(await readResident(name)) })
      if (target !== undefined) return files[0]
      return { ok: true, files }
    },

    add({ target, text, tags }) {
      return locked(async () => {
        if (target !== 'user' && target !== 'memory' && target !== 'journal') {
          return fail('bad_target', 'target 只能是 user、memory 或 journal')
        }
        const body = String(text ?? '').trim()
        if (body === '') return fail('empty', 'text 不能为空')
        const secret = rejectSecret(body)
        if (secret) return secret
        const id = idFactory()
        const tagText = normalizeTags(tags)
        if (target === 'journal') {
          const date = now()
          const day = zonedDay(date, tz)
          const path = journalFile(day)
          const stamped = `[${zonedStamp(date, tz)}]\n${body}`
          const current = await readOrEmpty(path)
          const next = appendEntry(current, { id, tags: tagText, text: stamped })
          await writeAtomic(path, next)
          const entry = eachItem(next).find((item) => item.id === id)
          return {
            ok: true,
            id,
            target,
            path,
            text: stamped,
            entry,
            affectedIds: [id],
            diff: makeDiff('', entry?.text ?? stamped, { path: relPath(path), startLine: lineNumberAt(next, entry?.start ?? 0) }),
            ...usageOf(target, next),
          }
        }
        const path = residentPath(target)
        const current = await readOrEmpty(path)
        const next = appendEntry(current, { id, tags: tagText, text: body })
        const overflow = overLimit(target, next, current, [id])
        if (overflow) return overflow
        await writeAtomic(path, next)
        const entry = eachItem(next).find((item) => item.id === id)
        return {
          ok: true,
          id,
          target,
          path,
          text: body,
          tags: tagText,
          entry,
          affectedIds: [id],
          diff: makeDiff('', entry?.text ?? body, { path: relPath(path), startLine: lineNumberAt(next, entry?.start ?? 0) }),
          ...usageOf(target, next),
        }
      })
    },

    replace({ target, id, anchor, text, tags }) {
      return locked(async () => {
        const body = text === undefined ? undefined : String(text)
        if (body !== undefined && body.trim() === '') return fail('empty', 'text 不能为空')
        if (body !== undefined) {
          const secret = rejectSecret(body)
          if (secret) return secret
        }
        const located = id ? await locateEntry(id) : await locateAnchor(anchor)
        if (located === 'ambiguous') return fail('ambiguous', '锚点匹配到多处。请改用 memory_list 里的 id。')
        if (!located) return fail('not_found', '没有找到要修改的条目。')
        if (target && located.target !== target && located.target !== 'journal') {
          return fail('not_found', `id 不在 ${target} 里。`)
        }
        const plan = planReplace(located, { id, anchor, body, tags })
        if (plan.error) return plan.error
        if (located.target === 'user' || located.target === 'memory') {
          const overflow = overLimit(located.target, plan.next, located.text, plan.affectedIds)
          if (overflow) return overflow
        }
        await writeAtomic(located.path, plan.next)
        return {
          ok: true,
          id: plan.id,
          ...(plan.previousId && plan.previousId !== plan.id ? { previousId: plan.previousId } : {}),
          affectedIds: plan.affectedIds,
          ...(plan.renames.length > 0 ? { renames: plan.renames } : {}),
          diff: plan.diff,
          entry: plan.entry,
          target: located.target,
          path: located.path,
          ...usageOf(located.target, plan.next),
        }
      })
    },

    remove({ target, id, anchor }) {
      return locked(async () => {
        const located = id ? await locateEntry(id) : await locateAnchor(anchor)
        if (located === 'ambiguous') return fail('ambiguous', '锚点匹配到多处。请改用 memory_list 里的 id。')
        if (!located) return fail('not_found', '没有找到要删除的条目。')
        if (target && target !== located.target) return fail('not_found', `id 不在 ${target} 里。`)
        const plan = planRemove(located, { id, anchor })
        if (plan.error) return plan.error
        await writeAtomic(located.path, plan.next)
        return {
          ok: true,
          id: plan.id,
          affectedIds: plan.affectedIds,
          ...(plan.removedIds ? { removedIds: plan.removedIds } : {}),
          ...(plan.renames.length > 0 ? { renames: plan.renames } : {}),
          diff: plan.diff,
          entry: plan.entry,
          target: located.target,
          path: located.path,
          ...usageOf(located.target, plan.next),
        }
      })
    },

    /**
     * Move a marked entry out of its Markdown file into archive/YYYY-MM.md.
     * Never a hard delete — restore() puts it back.
     */
    archive({ id, reason }) {
      return locked(async () => {
        if (!id || id === SYNTHETIC_ID) return fail('bad_id', '只能归档带 id 标记的条目。')
        const located = await locateEntry(id)
        if (!located) return fail('not_found', '没有找到要归档的条目。')
        if (located.where !== 'entry') return fail('bad_id', '只能归档带 id 标记的条目。')
        const item = listItems(located.text).find((entry) => entry.id === id)
        if (!item) return fail('not_found', '没有找到要归档的条目。')
        const next = removeMarked(located.text, id)
        if (next === undefined) return fail('not_found', '没有找到要归档的条目。')
        const from = relPath(located.path)
        const at = zonedStamp(now(), tz)
        const target = located.target
        const month = zonedMonth(now(), tz)
        const archivePath = join(archiveDir(), `${month}.md`)
        // Write the archive record first so a crash cannot lose the text.
        const currentArchive = await readOrEmpty(archivePath)
        await writeAtomic(archivePath, appendArchiveRecord(currentArchive, {
          id,
          file: target,
          from,
          at,
          reason: reason ?? '',
          tags: item.tags,
          text: item.text,
        }))
        await writeAtomic(located.path, next)
        return {
          ok: true,
          id,
          target,
          path: located.path,
          archivePath,
          from,
          at,
          ...usageOf(target, next),
        }
      })
    },

    /** Put an archived entry back where it came from. Over-limit restores are refused. */
    restore({ id }) {
      return locked(async () => {
        for (const archivePath of await archiveFiles()) {
          const raw = await readOrEmpty(archivePath)
          const record = findArchiveRecord(raw, id)
          if (!record) continue
          const targetPath = safeRestorePath(record.from, record.file, record.at)
          if (!targetPath) return fail('bad_record', '归档记录里的原路径不合法，已拒绝恢复。')
          const current = await readOrEmpty(targetPath)
          const next = appendEntry(current, { id: record.id, tags: record.tags, text: record.text })
          if (record.file === 'user' || record.file === 'memory') {
            const overflow = overLimit(record.file, next, current, [record.id])
            if (overflow) return overflow
          }
          await writeAtomic(targetPath, next)
          await writeAtomic(archivePath, removeArchiveRecord(raw, id))
          return {
            ok: true,
            id: record.id,
            target: record.file,
            path: targetPath,
            archivePath,
            ...usageOf(record.file, next),
          }
        }
        return fail('not_found', '归档里没有这个 id。')
      })
    },

    async listArchive() {
      const records = []
      for (const archivePath of await archiveFiles()) {
        const raw = await readOrEmpty(archivePath)
        for (const record of parseArchive(raw)) {
          records.push({ ...record, archivePath })
        }
      }
      return records
    },

    /** Files the indexer should read. Does not create anything. */
    async corpus() {
      const docs = []
      for (const target of ['user', 'memory']) {
        const path = residentPath(target)
        docs.push({ target, path, text: await readOrEmpty(path) })
      }
      for (const path of await journalPaths()) {
        docs.push({ target: 'journal', path, text: await readOrEmpty(path) })
      }
      return docs
    },
  }
}
