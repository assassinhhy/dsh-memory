/**
 * Markdown memory store. Reads and writes only files under the memory root
 * (USER.md, MEMORY.md, journal/YYYY-MM-DD.md). Never creates or rewrites
 * AGENTS.md. Seed prose is left byte-for-byte intact until a tool explicitly
 * edits that region.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { appendArchiveRecord, findArchiveRecord, parseArchive, removeArchiveRecord } from './archive.js'
import {
  appendEntry,
  findAnchor,
  listItems,
  longestEntries,
  normalizeTags,
  removeAnchor,
  removeMarked,
  removeUnfenced,
  replaceAnchor,
  replaceMarked,
  replaceUnfenced,
} from './document.js'
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

export function createStore(options = {}) {
  if (!options.root) throw new Error('createStore requires root (refusing to default inside tests/tools)')
  const root = options.root
  const now = options.now ?? (() => new Date())
  const tz = options.tz ?? 'Asia/Shanghai'
  const idFactory = options.idFactory ?? (() => `e-${randomBytes(4).toString('hex')}`)
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

  function overLimit(target, next) {
    const limit = LIMITS[target]
    if (limit === undefined) return undefined
    if (charLength(next) <= limit) return undefined
    const items = listItems(next)
    return fail('over_limit',
      `${target === 'user' ? 'USER.md' : 'MEMORY.md'} 写入后将达到 ${charLength(next)} 字符，上限 ${limit}。已拒绝写入，没有截断。请先合并或删除旧条目。`,
      { ...usageOf(target, next), suggestions: longestEntries(items) })
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

  async function locateEntry(id) {
    for (const target of ['user', 'memory']) {
      const path = residentPath(target)
      const text = await readOrEmpty(path)
      if (id === 'unfenced') {
        if (listItems(text).some((item) => item.id === 'unfenced')) return { target, path, text, where: 'unfenced' }
        continue
      }
      if (text.includes(`<!-- dsh-mem id="${id}" `)) return { target, path, text, where: 'entry' }
    }
    for (const path of await journalPaths()) {
      const text = await readOrEmpty(path)
      if (text.includes(`<!-- dsh-mem id="${id}" `)) return { target: 'journal', path, text, where: 'entry' }
    }
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
      if (target === 'journal' || target === undefined) {
        // list() without target returns both resident files; journal is opt-in.
      }
      if (target === 'journal') {
        const entries = []
        for (const path of await journalPaths()) {
          const text = await readOrEmpty(path)
          for (const item of listItems(text)) {
            if (item.kind === 'entry') entries.push({ ...item, path })
          }
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
          const next = appendEntry(await readOrEmpty(path), { id, tags: tagText, text: stamped })
          await writeAtomic(path, next)
          return { ok: true, id, target, path, text: stamped, ...usageOf(target, next) }
        }
        const path = residentPath(target)
        const current = await readOrEmpty(path)
        const next = appendEntry(current, { id, tags: tagText, text: body })
        const overflow = overLimit(target, next)
        if (overflow) return { ...overflow, ...usageOf(target, current) }
        await writeAtomic(path, next)
        return { ok: true, id, target, path, text: body, tags: tagText, ...usageOf(target, next) }
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
        let next
        if (located.where === 'unfenced') {
          if (body === undefined) return fail('empty', '修改未标记正文需要提供 text')
          next = replaceUnfenced(located.text, body.trim())
        } else if (id && located.where === 'entry') {
          const replaced = replaceMarked(located.text, id, { text: (body ?? '').trim(), tags })
          if (replaced === undefined) return fail('not_found', '没有找到要修改的条目。')
          next = body === undefined ? located.text : replaced
          if (body === undefined && tags !== undefined) {
            const onlyTags = replaceMarked(located.text, id, {
              text: listItems(located.text).find((item) => item.id === id)?.text ?? '',
              tags,
            })
            next = onlyTags ?? located.text
          }
        } else {
          if (body === undefined) return fail('empty', '按锚点修改需要提供 text')
          const replaced = replaceAnchor(located.text, anchor, body.trim())
          if (replaced === 'ambiguous') return fail('ambiguous', '锚点匹配到多处。请改用 id。')
          if (replaced === undefined) return fail('not_found', '没有找到要修改的条目。')
          next = replaced
        }
        if (located.target === 'user' || located.target === 'memory') {
          const overflow = overLimit(located.target, next)
          if (overflow) return overflow
        }
        await writeAtomic(located.path, next)
        return { ok: true, id: id ?? null, target: located.target, path: located.path, ...usageOf(located.target, next) }
      })
    },

    remove({ target, id, anchor }) {
      return locked(async () => {
        const located = id ? await locateEntry(id) : await locateAnchor(anchor)
        if (located === 'ambiguous') return fail('ambiguous', '锚点匹配到多处。请改用 memory_list 里的 id。')
        if (!located) return fail('not_found', '没有找到要删除的条目。')
        if (target && target !== located.target) return fail('not_found', `id 不在 ${target} 里。`)
        let next
        if (located.where === 'unfenced' || id === 'unfenced') next = removeUnfenced(located.text)
        else if (id) {
          next = removeMarked(located.text, id)
          if (next === undefined) return fail('not_found', '没有找到要删除的条目。')
        } else {
          next = removeAnchor(located.text, anchor)
          if (next === 'ambiguous') return fail('ambiguous', '锚点匹配到多处。请改用 id。')
          if (next === undefined) return fail('not_found', '没有找到要删除的条目。')
        }
        await writeAtomic(located.path, next)
        return { ok: true, id: id ?? null, target: located.target, path: located.path, ...usageOf(located.target, next) }
      })
    },

    /**
     * Move a marked entry out of its Markdown file into archive/YYYY-MM.md.
     * Never a hard delete — restore() puts it back.
     */
    archive({ id, reason }) {
      return locked(async () => {
        if (!id || id === 'unfenced') return fail('bad_id', '只能归档带 id 标记的条目。')
        const located = await locateEntry(id)
        if (!located) return fail('not_found', '没有找到要归档的条目。')
        if (located.where !== 'entry') return fail('bad_id', '只能归档带 id 标记的条目。')
        const item = listItems(located.text).find((entry) => entry.id === id)
        if (!item) return fail('not_found', '没有找到要归档的条目。')
        const next = removeMarked(located.text, id)
        if (next === undefined) return fail('not_found', '没有找到要归档的条目。')
        const from = located.path.slice(root.length + 1).replaceAll('\\', '/')
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
            const overflow = overLimit(record.file, next)
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
