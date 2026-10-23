/**
 * Soft delete: an auto-review DELETE archives (recoverable), never removes.
 * Archive/restore also works for M3 `l-…` / `p-…` entries, byte-for-byte.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRuntime } from '../packages/dsh-memory/src/runtime.js'
import { applyReviewDecision, parseReviewDecision } from '../packages/dsh-memory/src/review.js'
import { createStore } from '../packages/dsh-memory/src/store.js'

const NOW = Date.UTC(2026, 9, 23, 4, 0, 0)

const fakeEmbedder = {
  status: () => ({ state: 'ready', model: 'fake' }),
  warmup() {},
  async embed(texts) {
    return texts.map(() => new Float32Array([1, 0]))
  },
}

async function seeded(memoryText) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-review-'))
  await writeFile(join(root, 'MEMORY.md'), memoryText, 'utf8')
  let n = 0
  const store = createStore({
    root,
    now: () => new Date(NOW),
    idFactory: () => `e-test${String(++n).padStart(2, '0')}`,
  })
  return { root, store }
}

test('parse: DELETE needs a locator and stays an accepted action', () => {
  assert.equal(parseReviewDecision('{"action":"delete","target":"memory"}').decision.action, 'NOOP')
  assert.equal(parseReviewDecision('{"action":"delete","target":"memory"}').decision.reason, 'no_locator')
  const byAnchor = parseReviewDecision('{"action":"DELETE","target":"memory","anchor":"旧条目"}')
  assert.equal(byAnchor.decision.action, 'DELETE')
  assert.equal(byAnchor.decision.anchor, '旧条目')
})

test('review DELETE archives the entry and never truncates the rest of the file', async () => {
  const raw = '# MEMORY\n\n- 保留甲\n\n- 要归档的条目\n\n- 保留乙\n'
  const { root, store } = await seeded(raw)
  const victim = (await store.list('memory')).entries.find((entry) => entry.text.includes('要归档的条目'))
  assert.ok(victim.id.startsWith('l-'))

  const decision = parseReviewDecision(JSON.stringify({ action: 'DELETE', target: 'memory', id: victim.id })).decision
  const applied = await applyReviewDecision(store, decision)
  assert.equal(applied.ok, true, applied.error)
  assert.equal(applied.applied, 'ARCHIVED')
  assert.equal(applied.id, victim.id)

  // Only the victim line and one blank separator are gone; every other byte stays.
  const after = await readFile(join(root, 'MEMORY.md'), 'utf8')
  assert.equal(after, '# MEMORY\n\n- 保留甲\n\n- 保留乙\n')
  assert.equal(after.includes('要归档的条目'), false)

  const archived = await store.listArchive()
  assert.equal(archived.length, 1)
  assert.equal(archived[0].id, victim.id)
  assert.equal(archived[0].file, 'memory')
  assert.equal(archived[0].from, 'MEMORY.md')
  assert.equal(archived[0].reason, 'auto-review')
  assert.ok(archived[0].text.includes('要归档的条目'))

  // Recoverable: restore brings the same content-hash id back.
  const restored = await store.restore({ id: victim.id })
  assert.equal(restored.ok, true, restored.error)
  assert.equal(restored.id, victim.id)
  assert.equal(restored.kind, 'item')
  const back = await readFile(join(root, 'MEMORY.md'), 'utf8')
  assert.ok(back.includes('要归档的条目'))
  const ids = (await store.list('memory')).entries.map((entry) => entry.id)
  assert.ok(ids.includes(victim.id), 'restored l- entry keeps its content-hash id')
  assert.equal((await store.listArchive()).length, 0)
})

test('review DELETE resolves an anchor to the entry before archiving', async () => {
  const { root, store } = await seeded('# 头\n\n- 甲\n- 要归档乙\n- 丙\n')
  const decision = parseReviewDecision('{"action":"DELETE","target":"memory","anchor":"要归档乙"}').decision
  const applied = await applyReviewDecision(store, decision)
  assert.equal(applied.ok, true, applied.error)
  assert.ok(applied.id.startsWith('l-'))
  const after = await readFile(join(root, 'MEMORY.md'), 'utf8')
  assert.equal(after, '# 头\n\n- 甲\n- 丙\n')
  const archived = await store.listArchive()
  assert.equal(archived.length, 1)
  assert.ok(archived[0].text.includes('要归档乙'))
})

test('archive by anchor also works for a marked e- entry', async () => {
  const { root, store } = await seeded('# 头\n')
  const added = await store.add({ target: 'memory', text: '标记条目正文', tags: 'x' })
  assert.equal(added.ok, true, added.error)
  const archived = await store.archive({ anchor: '标记条目正文', reason: 'manual' })
  assert.equal(archived.ok, true, archived.error)
  assert.equal(archived.id, added.id)
  assert.equal(archived.kind, 'entry')
  assert.equal(await readFile(join(root, 'MEMORY.md'), 'utf8'), '# 头\n')
  const restored = await store.restore({ id: added.id })
  assert.equal(restored.ok, true, restored.error)
  assert.ok((await readFile(join(root, 'MEMORY.md'), 'utf8')).includes('标记条目正文'))
  assert.ok((await store.list('memory')).entries.some((entry) => entry.id === added.id))
})

test('archive/restore handles a p- prose block without touching its neighbours', async () => {
  const raw = '# 头\n\n第一段。\n\n第二段。\n'
  const { root, store } = await seeded(raw)
  const prose = (await store.list('memory')).entries.find((entry) => entry.kind === 'prose' && entry.text === '第一段。')
  assert.ok(prose.id.startsWith('p-'))

  const archived = await store.archive({ id: prose.id, reason: 'stale' })
  assert.equal(archived.ok, true, archived.error)
  assert.equal(archived.kind, 'prose')
  assert.equal(await readFile(join(root, 'MEMORY.md'), 'utf8'), '# 头\n\n第二段。\n')

  const records = await store.listArchive()
  assert.equal(records.length, 1)
  assert.equal(records[0].id, prose.id)
  assert.equal(records[0].text, '第一段。')

  const restored = await store.restore({ id: prose.id })
  assert.equal(restored.ok, true, restored.error)
  assert.equal(restored.id, prose.id)
  assert.equal(restored.kind, 'item')
  const back = await readFile(join(root, 'MEMORY.md'), 'utf8')
  assert.ok(back.startsWith('# 头\n\n第二段。\n\n'), 'neighbours keep their bytes')
  assert.ok(back.includes('第一段。'))
  const listed = await store.list('memory')
  assert.ok(listed.entries.some((entry) => entry.id === prose.id && entry.kind === 'prose'))
})

test('archive/restore keeps a multi-line l- item intact', async () => {
  const raw = '- 父\n  - 子\n- 兄弟\n'
  const { root, store } = await seeded(raw)
  const parent = (await store.list('memory')).entries.find((entry) => entry.text.includes('父'))
  const archived = await store.archive({ id: parent.id, reason: 'manual' })
  assert.equal(archived.ok, true, archived.error)
  assert.equal(await readFile(join(root, 'MEMORY.md'), 'utf8'), '- 兄弟\n')
  const restored = await store.restore({ id: parent.id })
  assert.equal(restored.ok, true, restored.error)
  const back = await readFile(join(root, 'MEMORY.md'), 'utf8')
  assert.ok(back.includes('- 父\n  - 子'))
  assert.ok((await store.list('memory')).entries.some((entry) => entry.id === parent.id))
})

test('archive refuses the synthetic unfenced alias', async () => {
  const { store } = await seeded('只有正文，没有列表。\n')
  const result = await store.archive({ id: 'unfenced' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad_id')
})

test('a failed archive never falls back to a hard remove', async () => {
  const calls = []
  const store = {
    add: async () => ({ ok: true }),
    replace: async () => ({ ok: true }),
    remove: async (input) => {
      calls.push(['remove', input])
      return { ok: true }
    },
    archive: async (input) => {
      calls.push(['archive', input])
      return { ok: false, code: 'over_limit', error: '归档失败' }
    },
  }
  const result = await applyReviewDecision(store, { action: 'DELETE', target: 'memory', id: 'e-1' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'over_limit')
  assert.deepEqual(calls.map((call) => call[0]), ['archive'])

  // A store without archive must fail closed, not remove.
  const bare = {
    remove: async () => {
      throw new Error('hard delete must never be reached')
    },
  }
  const refused = await applyReviewDecision(bare, { action: 'DELETE', target: 'memory', id: 'e-1' })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'no_archive')
})

test('runtime tracks archived metadata for l-/p- entries like e- entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-review-rt-'))
  await writeFile(join(root, 'MEMORY.md'), '- 列表项\n\n一段散文。\n', 'utf8')
  const runtime = createRuntime({
    root,
    embedder: fakeEmbedder,
    idFactory: () => 'e-rt01',
    now: () => new Date(NOW),
    scoring: () => ({ halfLifeDays: { user: 60, memory: 60, journal: 21 }, boost: 0.25 }),
  })
  await runtime.start()
  try {
    const entries = (await runtime.list('memory')).entries
    const item = entries.find((entry) => entry.kind === 'item')
    const prose = entries.find((entry) => entry.kind === 'prose')

    const archivedItem = await runtime.archive({ id: item.id, reason: 'test' })
    assert.equal(archivedItem.ok, true, archivedItem.error)
    assert.equal(runtime.meta.get(item.id).archivedAt, NOW)

    const archivedProse = await runtime.archive({ id: prose.id, reason: 'test' })
    assert.equal(archivedProse.ok, true, archivedProse.error)
    assert.equal(runtime.meta.get(prose.id).archivedAt, NOW)

    const restored = await runtime.restore({ id: item.id })
    assert.equal(restored.ok, true, restored.error)
    assert.equal(runtime.meta.get(item.id).archivedAt, null)
    assert.equal((await runtime.listArchive()).length, 1, 'only the prose is still archived')
  } finally {
    await runtime.stop()
  }
})
