/**
 * Entry metadata side table inside index.sqlite, keyed by entry id (e-…, p-…,
 * unfenced). Markdown stays the source of truth: sync() realigns the table after
 * hand edits — new id gets a row, a vanished id is marked orphan (kept, not
 * deleted), a rewritten id keeps its usage counters and updates last_seen_hash.
 *
 * Fields (per CLAUDE_TASK_M2): id, file, created_at, last_used_at, use_count,
 * pinned, archived_at, last_seen_hash — plus orphaned_at so a hand-deleted id
 * can be told apart from an archived one (archived entries leave the corpus on
 * purpose and must not be marked orphan).
 */
import { createHash } from 'node:crypto'

const DEFAULT_NOW = () => new Date()

function hashText(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex')
}

function toMs(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : null
  }
  const text = String(value).trim()
  if (/^-?\d+(\.\d+)?$/u.test(text)) {
    const epoch = Number(text)
    return Number.isFinite(epoch) ? Math.round(epoch) : null
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

function rowToMeta(row) {
  if (!row) return undefined
  return {
    id: row.id,
    file: row.file,
    createdAt: row.created_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    useCount: Number(row.use_count) || 0,
    pinned: row.pinned === 1 || row.pinned === true,
    archivedAt: row.archived_at ?? null,
    orphanedAt: row.orphaned_at ?? null,
    lastSeenHash: row.last_seen_hash ?? '',
  }
}

export function ensureMetaSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entry_meta (
      id TEXT PRIMARY KEY,
      file TEXT NOT NULL,
      created_at INTEGER,
      last_used_at INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      orphaned_at INTEGER,
      last_seen_hash TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS entry_meta_file ON entry_meta (file);
    CREATE INDEX IF NOT EXISTS entry_meta_archived ON entry_meta (archived_at);
  `)
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ now?: () => Date | number | string }} options
 */
export function createMetaStore(db, options = {}) {
  ensureMetaSchema(db)
  const now = options.now ?? DEFAULT_NOW

  const getRow = db.prepare('SELECT * FROM entry_meta WHERE id = ?')
  const getRows = db.prepare('SELECT * FROM entry_meta')
  const insertRow = db.prepare(`
    INSERT INTO entry_meta (id, file, created_at, last_used_at, use_count, pinned, archived_at, orphaned_at, last_seen_hash)
    VALUES (?, ?, ?, NULL, 0, ?, NULL, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET file = excluded.file, last_seen_hash = excluded.last_seen_hash
  `)
  const touchHash = db.prepare('UPDATE entry_meta SET last_seen_hash = ? WHERE id = ?')
  const markOrphan = db.prepare('UPDATE entry_meta SET orphaned_at = ? WHERE id = ? AND archived_at IS NULL AND orphaned_at IS NULL')
  const clearOrphan = db.prepare('UPDATE entry_meta SET orphaned_at = NULL WHERE id = ?')
  const bumpUse = db.prepare('UPDATE entry_meta SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?')
  const setPin = db.prepare('UPDATE entry_meta SET pinned = ? WHERE id = ?')
  const setArchive = db.prepare('UPDATE entry_meta SET archived_at = ? WHERE id = ?')
  const deleteRow = db.prepare('DELETE FROM entry_meta WHERE id = ?')
  const moveRow = db.prepare(`
    UPDATE entry_meta SET id = ?, file = ?, created_at = ?, last_used_at = ?, use_count = ?,
      pinned = ?, archived_at = ?, orphaned_at = ?, last_seen_hash = ?
    WHERE id = ?
  `)
  const mergeRow = db.prepare(`
    UPDATE entry_meta SET file = ?, created_at = ?, last_used_at = ?, use_count = ?,
      pinned = ?, archived_at = ?, orphaned_at = NULL, last_seen_hash = ?
    WHERE id = ?
  `)
  const kvSelect = db.prepare('SELECT value FROM meta WHERE key = ?')
  const kvUpsert = db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `)

  function defaultPinned(file) {
    return file === 'user' ? 1 : 0
  }

  function upsert(chunk, seenAt) {
    const id = String(chunk.id)
    const file = String(chunk.file ?? 'memory')
    const hash = hashText(chunk.text)
    const existing = rowToMeta(getRow.get(id))
    if (!existing) {
      insertRow.run(id, file, toMs(seenAt), defaultPinned(file), hash)
      return { id, created: true }
    }
    if (existing.lastSeenHash !== hash) touchHash.run(hash, id)
    if (existing.orphanedAt != null) clearOrphan.run(id)
    return { id, created: false }
  }

  return {
    db,

    /**
     * Realign with the markdown. `chunks` are the live ids: [{ id, file, text }].
     * New ids get metadata (USER.md defaults to pinned); ids that vanished are
     * marked orphan; archived rows are left alone — they left the corpus on
     * purpose.
     */
    sync(chunks, opts = {}) {
      const seenAt = toMs(opts.now) ?? toMs(now())
      const live = new Map()
      for (const chunk of chunks ?? []) {
        if (!chunk?.id) continue
        live.set(String(chunk.id), chunk)
      }
      const result = { created: [], orphaned: [], rewritten: [] }
      db.exec('BEGIN')
      try {
        for (const [id, chunk] of live) {
          const before = rowToMeta(getRow.get(id))
          const outcome = upsert(chunk, seenAt)
          if (outcome.created) result.created.push(id)
          else if (before && before.lastSeenHash !== hashText(chunk.text)) result.rewritten.push(id)
        }
        for (const row of getRows.all()) {
          const id = String(row.id)
          if (live.has(id)) continue
          if (row.archived_at != null) continue
          if (row.orphaned_at != null) continue
          markOrphan.run(seenAt, id)
          result.orphaned.push(id)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return result
    },

    /** "Used" = returned by memory_search into the reply context, or edited via memory_replace. */
    markUsed(ids, opts = {}) {
      const at = toMs(opts.now) ?? toMs(now())
      const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String)
      if (list.length === 0) return 0
      let count = 0
      db.exec('BEGIN')
      try {
        for (const id of list) {
          const existing = rowToMeta(getRow.get(id))
          if (!existing) continue
          bumpUse.run(at, id)
          count += 1
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return count
    },

    setPinned(id, pinned, opts = {}) {
      const key = String(id)
      const value = pinned ? 1 : 0
      const existing = rowToMeta(getRow.get(key))
      if (!existing) {
        const seenAt = toMs(opts.now) ?? toMs(now())
        insertRow.run(key, opts.file ?? 'memory', seenAt, value, '')
        setPin.run(value, key)
        return rowToMeta(getRow.get(key))
      }
      setPin.run(value, key)
      return rowToMeta(getRow.get(key))
    },

    /** archivedAt null restores the row to the live set. */
    setArchived(id, archivedAt = null) {
      setArchive.run(toMs(archivedAt), String(id))
      return rowToMeta(getRow.get(String(id)))
    },

    get(id) {
      return rowToMeta(getRow.get(String(id)))
    },

    /**
     * Follow an id rename (replace rewrites a content-hash id, remove renumbers
     * a duplicate). Counters move from `from` to `to` — never an orphan plus a
     * fresh row. When both rows exist they are merged (use_count summed,
     * last_used_at kept, pinned OR'd) and `from` is dropped. `opts.replace`
     * drops a destination row that belongs to a just-deleted entry (remove of
     * the first of two identical items: the survivor takes over its id).
     */
    migrate(from, to, opts = {}) {
      const src = String(from)
      const dst = String(to)
      if (!src || !dst || src === dst) return undefined
      const source = rowToMeta(getRow.get(src))
      const target = rowToMeta(getRow.get(dst))
      if (!source) return target
      const seenAt = toMs(opts.now) ?? toMs(now())
      db.exec('BEGIN')
      try {
        if (!target || opts.replace) {
          if (target) deleteRow.run(dst)
          moveRow.run(
            dst,
            source.file,
            source.createdAt ?? seenAt,
            source.lastUsedAt,
            source.useCount,
            source.pinned ? 1 : 0,
            source.archivedAt,
            null,
            source.lastSeenHash,
            src,
          )
        } else {
          const pinned = source.pinned || target.pinned ? 1 : 0
          const createdAt = source.createdAt == null ? target.createdAt
            : target.createdAt == null ? source.createdAt
            : Math.min(source.createdAt, target.createdAt)
          const lastUsedAt = source.lastUsedAt == null ? target.lastUsedAt
            : target.lastUsedAt == null ? source.lastUsedAt
            : Math.max(source.lastUsedAt, target.lastUsedAt)
          const archivedAt = source.archivedAt == null ? target.archivedAt
            : target.archivedAt == null ? source.archivedAt
            : Math.min(source.archivedAt, target.archivedAt)
          mergeRow.run(
            target.file,
            createdAt ?? seenAt,
            lastUsedAt,
            source.useCount + target.useCount,
            pinned,
            archivedAt,
            target.lastSeenHash,
            dst,
          )
        }
        deleteRow.run(src)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return rowToMeta(getRow.get(dst))
    },

    /** Live rows only (not archived, not orphaned). */
    list() {
      return getRows.all().map(rowToMeta).filter((row) => row.archivedAt == null && row.orphanedAt == null)
    },

    listAll() {
      return getRows.all().map(rowToMeta)
    },

    byId() {
      return new Map(getRows.all().map((row) => {
        const meta = rowToMeta(row)
        return [meta.id, meta]
      }))
    },

    kvGet(key) {
      const row = kvSelect.get(String(key))
      return row?.value ?? undefined
    },

    kvSet(key, value) {
      kvUpsert.run(String(key), String(value))
      return String(value)
    },
  }
}
