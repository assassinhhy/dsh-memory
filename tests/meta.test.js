import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { chunksFrom } from '../packages/dsh-memory/src/index-db.js'
import { createMetaStore } from '../packages/dsh-memory/src/meta.js'
import { createStore } from '../packages/dsh-memory/src/store.js'

const DAY = 86400000
const NOW = Date.UTC(2026, 9, 22, 7, 0, 0)

function metaAt(date = new Date(NOW)) {
  const db = new DatabaseSync(':memory:')
  const meta = createMetaStore(db, { now: () => date })
  return { db, meta }
}

function chunksOf(corpus) {
  const items = []
  for (const doc of corpus) {
    for (const chunk of chunksFrom(doc.target, doc.path, doc.text)) {
      items.push({ id: chunk.entryId, file: chunk.target, text: chunk.text })
    }
  }
  return items
}

test('new ids get metadata and USER.md entries default to pinned', () => {
  const { meta } = metaAt()
  const result = meta.sync(chunksOf([
    { target: 'user', path: 'USER.md', text: '<!-- dsh-mem id="e-user1" tags="" -->\n称呼：主人\n<!-- /dsh-mem -->' },
    { target: 'memory', path: 'MEMORY.md', text: '<!-- dsh-mem id="e-mem1" tags="" -->\n默认用 pnpm\n<!-- /dsh-mem -->' },
  ]), { now: NOW })
  assert.deepEqual(result.created.sort(), ['e-mem1', 'e-user1'])
  const user = meta.get('e-user1')
  assert.equal(user.pinned, true)
  assert.equal(user.file, 'user')
  assert.equal(user.useCount, 0)
  assert.equal(user.createdAt, NOW)
  assert.equal(user.lastUsedAt, null)
  assert.equal(meta.get('e-mem1').pinned, false)
})

test('hand-deleted id is marked orphan, hand-edited text keeps counters', () => {
  const { meta } = metaAt()
  const before = chunksOf([
    { target: 'memory', path: 'MEMORY.md', text: '<!-- dsh-mem id="e-keep" tags="" -->\n原文\n<!-- /dsh-mem -->\n\n<!-- dsh-mem id="e-gone" tags="" -->\n要消失的\n<!-- /dsh-mem -->' },
  ])
  meta.sync(before, { now: NOW - 10 * DAY })
  meta.markUsed(['e-keep'], { now: NOW - 2 * DAY })
  meta.markUsed(['e-keep'], { now: NOW - 1 * DAY })
  assert.equal(meta.get('e-keep').useCount, 2)

  // Hand edit: e-gone deleted, e-keep rewritten.
  const after = chunksOf([
    { target: 'memory', path: 'MEMORY.md', text: '<!-- dsh-mem id="e-keep" tags="" -->\n改过的原文\n<!-- /dsh-mem -->' },
  ])
  meta.sync(after, { now: NOW })
  assert.equal(meta.get('e-gone').orphanedAt, NOW)
  const keep = meta.get('e-keep')
  assert.equal(keep.orphanedAt, null)
  assert.equal(keep.useCount, 2)
  assert.equal(keep.lastUsedAt, NOW - 1 * DAY)

  // Hand re-add restores the row.
  meta.sync(chunksOf([
    { target: 'memory', path: 'MEMORY.md', text: '<!-- dsh-mem id="e-gone" tags="" -->\n回来了\n<!-- /dsh-mem -->' },
  ]), { now: NOW })
  assert.equal(meta.get('e-gone').orphanedAt, null)
})

test('archived rows are not orphaned when they leave the corpus', () => {
  const { meta } = metaAt()
  meta.sync(chunksOf([
    { target: 'memory', path: 'MEMORY.md', text: '<!-- dsh-mem id="e-arch" tags="" -->\n待归档\n<!-- /dsh-mem -->' },
  ]), { now: NOW - DAY })
  meta.setArchived('e-arch', NOW)
  // Corpus no longer contains it (moved to archive/) — sync must leave the row alone.
  meta.sync([], { now: NOW })
  const row = meta.get('e-arch')
  assert.equal(row.orphanedAt, null)
  assert.equal(row.archivedAt, NOW)
  meta.setArchived('e-arch', null)
  meta.sync([], { now: NOW })
  assert.equal(meta.get('e-arch').orphanedAt, NOW)
})

test('markUsed only counts ids that exist', () => {
  const { meta } = metaAt()
  meta.sync(chunksOf([
    { target: 'journal', path: 'journal/2026-10-22.md', text: '<!-- dsh-mem id="e-j1" tags="" -->\n今天的事\n<!-- /dsh-mem -->' },
  ]), { now: NOW })
  assert.equal(meta.markUsed(['e-j1', 'e-nope'], { now: NOW }), 1)
  assert.equal(meta.get('e-j1').useCount, 1)
  assert.equal(meta.get('e-j1').lastUsedAt, NOW)
  assert.equal(meta.get('e-nope'), undefined)
})

test('markdown hand edits realign metadata through the store corpus', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-meta-'))
  const store = createStore({ root, idFactory: () => 'e-fixed' })
  const { meta } = metaAt()
  const syncFromDisk = async () => meta.sync(chunksOf(await store.corpus()), { now: NOW })

  await store.add({ target: 'memory', text: '记住这一条' })
  await syncFromDisk()
  assert.equal(meta.get('e-fixed').file, 'memory')
  meta.markUsed(['e-fixed'], { now: NOW })

  // Hand add a brand-new marked entry.
  const path = join(root, 'MEMORY.md')
  const base = await readFile(path, 'utf8')
  const handBlock = '<!-- dsh-mem id="e-hand" tags="new" -->\n手写的\n<!-- /dsh-mem -->\n'
  await writeFile(path, `${base}\n${handBlock}`, 'utf8')
  await syncFromDisk()
  assert.equal(meta.get('e-hand').createdAt, NOW)

  // Hand rewrite e-fixed's text: counters survive, hash follows.
  await writeFile(path, `${base.replace('记住这一条', '记住这一条（改过）')}\n${handBlock}`, 'utf8')
  await syncFromDisk()
  assert.equal(meta.get('e-fixed').useCount, 1)
  assert.equal(meta.get('e-hand').orphanedAt, null)

  // Hand delete e-hand: orphan, not deleted from the table.
  await writeFile(path, base.replace('记住这一条', '记住这一条（改过）'), 'utf8')
  await syncFromDisk()
  assert.equal(meta.get('e-hand').orphanedAt, NOW)
})
