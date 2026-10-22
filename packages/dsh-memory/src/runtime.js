/**
 * Host-agnostic memory runtime: markdown store, rebuildable index, lazy embedder,
 * entry metadata (usage/pin) and decay-scored search. Cordis wiring lives in
 * index.js so this can be tested without a harness.
 */
import { join } from 'node:path'
import { DEFAULT_HALF_LIFE_DAYS, DEFAULT_USE_BOOST, decayScore, toMs } from './decay.js'
import { createEmbedder } from './embed.js'
import { chunksFrom, createIndex } from './index-db.js'
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
  const store = createStore({ root, now: nowFn, tz: options.tz, idFactory: options.idFactory })
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
        if (result.ok) await sync()
        return result
      })
    },
    replace(input) {
      return locked(async () => {
        const result = await store.replace(input)
        if (result.ok) {
          // Edited via memory_replace counts as "used".
          if (result.id && index) index.meta.markUsed([result.id], { now: toMs(nowFn()) })
          await sync()
        }
        return result
      })
    },
    remove(input) {
      return locked(async () => {
        const result = await store.remove(input)
        if (result.ok) await sync()
        return result
      })
    },
    list(target) {
      return store.list(target)
    },
    /** Archive is reversible: the entry moves to archive/YYYY-MM.md, never deleted. */
    archive({ id, reason }) {
      return locked(async () => {
        await ready
        const result = await store.archive({ id, reason })
        if (result.ok && index) {
          index.meta.setArchived(id, toMs(nowFn()))
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
          index.meta.setArchived(id, null)
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
