/**
 * Plugin-owned index. Markdown remains the source of truth; this file is a
 * rebuildable FTS5 trigram + vector cache. node:sqlite ships with the dsh
 * Node runtime and has FTS5 trigram (verified on Node 26 / Windows x64).
 */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { rankHits } from './decay.js'
import { parseDocument } from './document.js'
import { createMetaStore } from './meta.js'
import { cosine, ftsPhrase, rrfMerge } from './search.js'

export const SCHEMA_VERSION = 1

function hashText(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function proseId(text) {
  return `p-${hashText(text).slice(0, 10)}`
}

export function chunksFrom(target, path, raw) {
  const chunks = []
  const push = (entryId, text, tags) => {
    chunks.push({ id: `${target}:${entryId}`, entryId, target, path, text, tags })
  }
  for (const segment of parseDocument(raw)) {
    if (segment.type === 'entry') {
      const text = segment.text.trim()
      if (text !== '') push(segment.id, text, segment.tags)
      continue
    }
    const blocks = segment.text.split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean)
    for (const block of blocks) push(proseId(block), block, '')
  }
  return chunks
}

function blob(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

function unblob(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
}

export function openIndex(file) {
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      path TEXT NOT NULL,
      text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      hash TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      text,
      tags,
      content='docs',
      content_rowid='rowid',
      tokenize='trigram'
    );
    CREATE TABLE IF NOT EXISTS vecs (
      id TEXT PRIMARY KEY,
      dim INTEGER NOT NULL,
      embedding BLOB NOT NULL
    );
  `)
  const version = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema')
  if (version?.value !== String(SCHEMA_VERSION)) {
    db.exec(`DELETE FROM docs; DELETE FROM vecs; INSERT INTO meta(key, value) VALUES ('schema', '${SCHEMA_VERSION}')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;`)
    try { db.exec("INSERT INTO docs_fts(docs_fts) VALUES ('rebuild')") } catch { /* empty */ }
  }
  return db
}

export async function createIndex(file, options = {}) {
  if (file !== ':memory:') await mkdir(dirname(file), { recursive: true })
  const db = openIndex(file)
  const meta = createMetaStore(db, { now: options.now })
  const upsert = db.prepare(`INSERT INTO docs(id, target, path, text, tags, hash) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET target = excluded.target, path = excluded.path, text = excluded.text, tags = excluded.tags, hash = excluded.hash`)
  const delDoc = db.prepare('DELETE FROM docs WHERE id = ?')
  const delVec = db.prepare('DELETE FROM vecs WHERE id = ?')
  const putVec = db.prepare('INSERT INTO vecs(id, dim, embedding) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET dim = excluded.dim, embedding = excluded.embedding')
  const allDocs = db.prepare('SELECT id, hash FROM docs')
  const pending = db.prepare(`SELECT docs.id, docs.text FROM docs LEFT JOIN vecs ON vecs.id = docs.id WHERE vecs.id IS NULL`)
  const byId = db.prepare('SELECT id, target, path, text, tags FROM docs WHERE id = ?')
  const vecs = db.prepare('SELECT id, dim, embedding FROM vecs')

  function rebuildFts() {
    db.exec("INSERT INTO docs_fts(docs_fts) VALUES ('rebuild')")
  }

  return {
    db,
    meta,
    close() {
      db.close()
    },

    /** Sync markdown chunks in. Returns ids whose vectors are missing. */
    sync(corpus) {
      const next = new Map()
      for (const doc of corpus) {
        for (const chunk of chunksFrom(doc.target, doc.path, doc.text)) {
          next.set(chunk.id, { ...chunk, hash: hashText(chunk.text) })
        }
      }
      const prev = new Map(allDocs.all().map((row) => [row.id, row.hash]))
      const changed = []
      db.exec('BEGIN')
      try {
        for (const [id, hash] of prev) {
          if (!next.has(id)) {
            delDoc.run(id)
            delVec.run(id)
          }
        }
        for (const chunk of next.values()) {
          if (prev.get(chunk.id) === chunk.hash) continue
          upsert.run(chunk.id, chunk.target, chunk.path, chunk.text, chunk.tags, chunk.hash)
          delVec.run(chunk.id)
          changed.push(chunk.id)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      if (changed.length > 0 || [...prev.keys()].some((id) => !next.has(id))) rebuildFts()
      return pending.all().map((row) => row.id)
    },

    pendingIds() {
      return pending.all().map((row) => row.id)
    },

    texts(ids) {
      return ids.map((id) => byId.get(id)).filter(Boolean)
    },

    putVectors(pairs) {
      db.exec('BEGIN')
      try {
        for (const { id, vector } of pairs) putVec.run(id, vector.length, blob(vector))
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    clearVectors() {
      db.exec('DELETE FROM vecs')
    },

    fts(query, limit = 20) {
      const phrase = ftsPhrase(query)
      if (phrase) {
        try {
          const rows = db.prepare(`
            SELECT docs.id, docs.target, docs.path, docs.text, docs.tags
            FROM docs_fts JOIN docs ON docs.rowid = docs_fts.rowid
            WHERE docs_fts MATCH ?
            LIMIT ?
          `).all(phrase, limit)
          if (rows.length > 0) return rows
        } catch {
          // A query the tokenizer rejects falls through to LIKE.
        }
      }
      const like = `%${String(query).replace(/[%_]/g, '')}%`
      if (like === '%%') return []
      return db.prepare(`
        SELECT id, target, path, text, tags FROM docs
        WHERE text LIKE ? ESCAPE '\\'
        LIMIT ?
      `).all(like, limit)
    },

    vector(queryVector, limit = 20) {
      const ranked = []
      for (const row of vecs.all()) {
        if (row.dim !== queryVector.length) continue
        ranked.push({ id: row.id, score: cosine(queryVector, unblob(row.embedding)) })
      }
      ranked.sort((a, b) => b.score - a.score)
      return ranked.slice(0, limit).map((row) => {
        const doc = byId.get(row.id)
        return doc ? { ...doc, score: row.score } : undefined
      }).filter(Boolean)
    },

    /**
     * RRF fusion, then decay re-ranking (`rrf × decay × use boost`). `score` is
     * the combined score; `rrf` keeps the raw fusion value. Hits without meta
     * keep score = rrf.
     */
    search({ query, queryVector, limit = 8, now, halfLifeDays, boost }) {
      const cap = Math.max(Number(limit) || 8, 24)
      const lexical = this.fts(query, cap).map((row) => ({ ...row }))
      const semantic = queryVector ? this.vector(queryVector, cap) : []
      const lists = []
      if (lexical.length > 0) lists.push({ source: 'fts', items: lexical })
      if (semantic.length > 0) lists.push({ source: 'vector', items: semantic })
      const merged = lists.length === 0 ? [] : rrfMerge(lists, { limit: cap })
      const hits = merged.map((hit) => {
        const doc = byId.get(hit.id)
        return {
          id: doc?.id?.startsWith(`${doc.target}:`) ? doc.id.slice(doc.target.length + 1) : hit.id,
          score: hit.score,
          sources: hit.sources,
          target: doc?.target ?? hit.target,
          path: doc?.path ?? hit.path,
          text: doc?.text ?? hit.text,
          tags: doc?.tags ?? hit.tags ?? '',
        }
      })
      return {
        vector: Boolean(queryVector),
        hits: rankHits(hits, meta.byId(), { now, halfLifeDays, boost, limit }),
      }
    },
  }
}
