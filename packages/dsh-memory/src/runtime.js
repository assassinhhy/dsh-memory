/**
 * Host-agnostic memory runtime: markdown store, rebuildable index, lazy embedder,
 * entry metadata (usage/pin) and decay-scored search. Cordis wiring lives in
 * index.js so this can be tested without a harness.
 */
import { join } from 'node:path'
import { DEFAULT_HALF_LIFE_DAYS, DEFAULT_USE_BOOST, decayScore, toMs } from './decay.js'
import { createEmbedder } from './embed.js'
import { chunksFrom, createIndex } from './index-db.js'
import { detectKeyFact } from './keyfact.js'
import { fileFor } from './paths.js'
import { createStore } from './store.js'

function chain(previous) {
  let current = previous ?? Promise.resolve()
  return (fn) => {
    const run = current.then(fn, fn)
    current = run.then(() => {}, () => {})
    return run
  }
}

export function createRuntime(options) {
  const root = options.root
  const logger = options.logger ?? console
  const nowFn = options.now ?? (() => new Date())
  const store = createStore({
    root,
    now: nowFn,
    tz: options.tz,
    idFactory: options.idFactory,
    // Over-limit planning wants pin state: longest-unused first, pinned never suggested.
    getMeta: (id) => index?.meta?.get?.(id),
  })
  const embedder = options.embedder ?? createEmbedder({
    cacheDir: join(root, 'models'),
    proxy: options.proxy,
    logger,
  })
  const scoring = () => ({
    halfLifeDays: { ...DEFAULT_HALF_LIFE_DAYS, ...(typeof options.scoring === 'function' ? options.scoring()?.halfLifeDays : options.scoring?.halfLifeDays) },
    boost: (typeof options.scoring === 'function' ? options.scoring()?.boost : options.scoring?.boost) ?? DEFAULT_USE_BOOST,
  })
  const locked = chain()
  let index
  let ready = Promise.resolve()

  async function open() {
    index = await createIndex(join(root, 'index.sqlite'), { now: nowFn })
    await sync()
    if (await vectorsEnabled()) embedder.warmup()
  }

  async function sync() {
    if (!index) return []
    const corpus = await store.corpus()
    const pending = index.sync(corpus)
    // Keep entry metadata aligned with markdown: new id → row, vanished → orphan.
    const items = []
    for (const doc of corpus) {
      for (const chunk of chunksFrom(doc.target, doc.path, doc.text)) {
        items.push({ id: chunk.entryId, file: chunk.target, text: chunk.text })
      }
    }
    index.meta.sync(items, { now: toMs(nowFn()) })
    return pending
  }

  async function findEntry(id) {
    for (const target of ['user', 'memory', 'journal']) {
      const listed = await store.list(target)
      if ((listed.entries ?? []).some((entry) => entry.id === id)) return target
    }
    return undefined
  }

  /**
   * Order renames so an id is vacated before anything moves into it. A rewrite
   * that lands on a sibling's id (`l-aaa` → `l-foo` while `l-foo` → `l-foo~2`)
   * would otherwise merge the two rows and hand the counters to the sibling.
   */
  function orderRenames(renames) {
    const pending = renames.filter(([from, to]) => from && to && from !== to)
    const bySource = new Map()
    for (const rename of pending) if (!bySource.has(rename[0])) bySource.set(rename[0], rename)
    const seen = new Set()
    const ordered = []
    const visit = (rename, stack) => {
      const key = `${rename[0]}>${rename[1]}`
      if (seen.has(key) || stack.has(key)) return
      stack.add(key)
      const blocker = bySource.get(rename[1])
      if (blocker) visit(blocker, stack)
      stack.delete(key)
      if (seen.has(key)) return
      seen.add(key)
      ordered.push(rename)
    }
    for (const rename of pending) visit(rename, new Set())
    return ordered
  }

  /**
   * Migrate entry_meta across id renames before the index re-syncs. A rename
   * into a just-deleted id (remove of the first of two identical items) replaces
   * the destination row instead of merging with it.
   */
  function applyRenames(renames, staleIds) {
    if (!index || !Array.isArray(renames)) return
    const stale = new Set((staleIds ?? []).map(String))
    for (const [from, to] of orderRenames(renames)) {
      index.meta.migrate(from, to, { now: toMs(nowFn()), replace: stale.has(to) })
    }
  }

  /**
   * Stable environment facts (host / port / path / url / ip / account) are worth
   * keeping — *suggest* pinning them, never pin automatically. USER.md rows are
   * pinned by default, so this mostly fires for MEMORY.md.
   */
  function suggestPinFor(result) {
    if (!result?.ok || !result.id) return undefined
    const file = result.target
    if (file !== 'user' && file !== 'memory') return undefined
    const text = result.entry?.text ?? result.text ?? ''
    const { kinds } = detectKeyFact(text)
    if (kinds.length === 0) return undefined
    const row = index?.meta?.get?.(result.id)
    const pinned = row?.pinned ?? file === 'user'
    if (pinned) return undefined
    return { id: result.id, kinds }
  }

  async function backfill() {
    if (!index || embedder.status().state !== 'ready') return false
    const ids = index.pendingIds()
    if (ids.length === 0) return true
    const docs = index.texts(ids)
    const vectors = await embedder.embed(docs.map((doc) => doc.text))
    index.putVectors(docs.map((doc, i) => ({ id: doc.id, vector: vectors[i] })))
    return true
  }

  async function vectorsEnabled() {
    if (typeof options.embedEnabled === 'function') return options.embedEnabled() !== false
    return options.embed !== false
  }

  async function waitForVector(waitMs) {
    if (!await vectorsEnabled()) return false
    if (embedder.status().state === 'ready') return true
    if (embedder.status().state === 'error' || waitMs <= 0) return false
    embedder.warmup()
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      const state = embedder.status().state
      if (state === 'ready') return true
      if (state === 'error') return false
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return embedder.status().state === 'ready'
  }

  return {
    store,
    get index() { return index },
    get meta() { return index?.meta },
    embedder,
    start() {
      ready = open().catch((error) => {
        logger.warn?.(`memory index unavailable: ${error?.message ?? error}`)
      })
      return ready
    },
    async stop() {
      await ready
      index?.close()
      index = undefined
    },
    status() {
      return {
        root,
        index: Boolean(index),
        embed: embedder.status(),
      }
    },
    add(input) {
      return locked(async () => {
        const result = await store.add(input)
        if (result.ok) {
          await sync()
          const suggestPin = suggestPinFor(result)
          if (suggestPin) result.suggestPin = suggestPin
        }
        return result
      })
    },
    replace(input) {
      return locked(async () => {
        const result = await store.replace(input)
        if (result.ok) {
          // Counters follow the id rename; edited via memory_replace counts as "used".
          applyRenames(result.renames)
          if (result.id && index) index.meta.markUsed([result.id], { now: toMs(nowFn()) })
          await sync()
          const suggestPin = suggestPinFor(result)
          if (suggestPin) result.suggestPin = suggestPin
        }
        return result
      })
    },
    remove(input) {
      return locked(async () => {
        const result = await store.remove(input)
        if (result.ok) {
          // A renumbered duplicate keeps its metadata under the surviving id.
          applyRenames(result.renames, result.removedIds)
          await sync()
        }
        return result
      })
    },
    list(target) {
      return store.list(target).then((listed) => {
        const decorate = (entry, file) => {
          if (!entry?.id || entry.id === 'unfenced') return entry
          const row = index?.meta?.get?.(entry.id)
          return {
            ...entry,
            pinned: row?.pinned ?? file === 'user',
            useCount: row?.useCount ?? 0,
          }
        }
        if (listed.entries) return { ...listed, entries: listed.entries.map((entry) => decorate(entry, listed.target)) }
        if (listed.files) {
          return {
            ...listed,
            files: listed.files.map((file) => ({ ...file, entries: (file.entries ?? []).map((entry) => decorate(entry, file.target)) })),
          }
        }
        return listed
      })
    },
    /** Archive is reversible: the entry moves to archive/YYYY-MM.md, never deleted. */
    archive({ id, anchor, target, reason }) {
      return locked(async () => {
        await ready
        const result = await store.archive({ id, anchor, target, reason })
        if (result.ok && index) {
          // Removing an l-/p- duplicate can renumber a sibling into its id.
          applyRenames(result.renames, result.removedIds)
          index.meta.setArchived(result.id, toMs(nowFn()))
          await sync()
        }
        return result
      })
    },
    restore({ id }) {
      return locked(async () => {
        await ready
        const result = await store.restore({ id })
        if (result.ok && index) {
          const restoredId = result.restoredId ?? result.id
          if (restoredId !== result.id) {
            // A duplicate suffix can change on restore; carry metadata over.
            index.meta.migrate(result.id, restoredId)
            index.meta.setArchived(restoredId, null)
          } else {
            index.meta.setArchived(result.id, null)
          }
          await sync()
        }
        return result
      })
    },
    listArchive() {
      return store.listArchive()
    },
    /** USER.md entries are pinned by default; MEMORY.md entries can be pinned here or via memory_pin. */
    pin({ id, pinned, file }) {
      return locked(async () => {
        await ready
        if (!index) return { ok: false, error: '索引没有打开' }
        const found = await findEntry(id)
        if (!found) return { ok: false, code: 'not_found', error: '没有这个 id。' }
        const row = index.meta.setPinned(id, pinned !== false, { file: file ?? found })
        return { ok: true, id, pinned: row.pinned, file: row.file }
      })
    },
    /** Entries with their metadata merged in — what the settings page lists. */
    async entriesWithMeta() {
      const metaById = index ? index.meta.byId() : new Map()
      const params = scoring()
      const now = toMs(nowFn())
      const out = []
      for (const file of ['user', 'memory', 'journal']) {
        const listed = await store.list(file)
        for (const entry of listed.entries ?? []) {
          const row = metaById.get(entry.id)
          const meta = {
            file,
            pinned: row?.pinned ?? file === 'user',
            useCount: row?.useCount ?? 0,
            createdAt: row?.createdAt ?? null,
            lastUsedAt: row?.lastUsedAt ?? null,
          }
          out.push({
            id: entry.id,
            file,
            kind: entry.kind,
            text: entry.text,
            chars: entry.chars,
            tags: entry.tags,
            path: entry.path ?? fileFor(root, file),
            pinned: meta.pinned,
            useCount: meta.useCount,
            createdAt: meta.createdAt,
            lastUsedAt: meta.lastUsedAt,
            decayScore: decayScore({ meta, now, halfLifeDays: params.halfLifeDays, boost: params.boost }),
          })
        }
      }
      return out
    },
    reindex() {
      return locked(async () => {
        await ready
        if (!index) return { ok: false, error: '索引没有打开' }
        index.clearVectors()
        await sync()
        const vectors = await backfill().catch((error) => {
          logger.warn?.(`reindex embed failed: ${error?.message ?? error}`)
          return false
        })
        return { ok: true, vector: vectors, embed: embedder.status() }
      })
    },
    /**
     * Ranked by `rrf × decay × use boost`. Returned hits count as "used" —
     * they enter the reply context (session-start injection does not count).
     */
    search({ query, limit = 8, waitMs = 0, markUsed = true }) {
      return locked(async () => {
        await ready
        if (!index) return { ok: false, error: '索引没有打开，只能直接查看 Markdown 文件。' }
        await sync()
        const vectorOn = await waitForVector(waitMs)
        let vectorNote
        if (vectorOn) {
          try {
            await backfill()
          } catch (error) {
            vectorNote = error?.message ?? String(error)
          }
        } else {
          vectorNote = embedder.status().error ?? embedder.status().state
        }
        const queryVector = vectorOn
          ? (await embedder.embed([query]))[0]
          : undefined
        const params = scoring()
        const found = index.search({
          query,
          queryVector,
          limit,
          now: toMs(nowFn()),
          halfLifeDays: params.halfLifeDays,
          boost: params.boost,
        })
        if (markUsed && found.hits.length > 0) {
          index.meta.markUsed(found.hits.map((hit) => hit.id), { now: toMs(nowFn()) })
        }
        return { ok: true, ...found, vector: Boolean(queryVector), vectorNote }
      })
    },
  }
}
