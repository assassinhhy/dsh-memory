import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRuntime } from '../packages/dsh-memory/src/runtime.js'

const fakeEmbedder = {
  status: () => ({ state: 'ready', model: 'fake' }),
  warmup() {},
  async embed(texts) {
    return texts.map(() => new Float32Array([1, 0]))
  },
}

async function scenario() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-rank-'))
  const clock = { ms: Date.UTC(2026, 2, 1, 0, 0, 0) }
  let n = 0
  const runtime = createRuntime({
    root,
    embedder: fakeEmbedder,
    embedEnabled: () => false,
    idFactory: () => `e-r${++n}`,
    now: () => new Date(clock.ms),
    scoring: () => ({ halfLifeDays: { user: 60, memory: 60, journal: 21 }, boost: 0.25 }),
  })
  await runtime.start()

  // Old entries first, so FTS gives them the best raw ranks — decay must still sink them.
  const old = await runtime.add({ target: 'memory', text: 'pnpm 约定：很旧的一条，一直没再用到' })
  const pinned = await runtime.add({ target: 'memory', text: 'pnpm 约定：置顶的关键约定' })
  clock.ms = Date.UTC(2026, 9, 22, 7, 0, 0)
  const frequent = await runtime.add({ target: 'memory', text: 'pnpm 约定：最近常用的条目' })
  await runtime.pin({ id: pinned.id, pinned: true })
  for (let i = 0; i < 8; i++) runtime.meta.markUsed([frequent.id], { now: clock.ms })
  return { root, runtime, clock, ids: { old: old.id, pinned: pinned.id, frequent: frequent.id } }
}

test('memory_search sinks an old unused entry below pinned and frequently used ones', async () => {
  const { runtime, ids } = await scenario()
  const found = await runtime.search({ query: 'pnpm 约定', limit: 8, waitMs: 0, markUsed: false })
  assert.equal(found.ok, true, found.error)
  assert.equal(found.hits.length, 3)
  const order = found.hits.map((hit) => hit.id)
  assert.ok(order.includes(ids.old))
  assert.equal(order[2], ids.old, `old entry should rank last, got ${order.join(' > ')}`)
  assert.equal(order[0], ids.frequent, `frequent entry should rank first, got ${order.join(' > ')}`)
  assert.equal(order[1], ids.pinned)
  // score carries the decay story; last_used tells the model how fresh it is
  const old = found.hits[2]
  const pinnedHit = found.hits[1]
  assert.ok(old.score < pinnedHit.score)
  assert.equal(pinnedHit.lastUsed, null)
  assert.equal(pinnedHit.pinned, true)
  assert.equal(found.hits[0].useCount, 8)
  assert.equal(found.hits[0].lastUsed, Date.UTC(2026, 9, 22, 7, 0, 0))
  await runtime.stop()
})

test('search results count as used; session-start injection does not', async () => {
  const { runtime, ids } = await scenario()
  const first = await runtime.search({ query: 'pnpm 约定', limit: 8, waitMs: 0 })
  assert.equal(first.ok, true, first.error)
  // All three returned hits got one use; the old one was refreshed by being seen.
  assert.equal(runtime.meta.get(ids.old).useCount, 1)
  assert.equal(runtime.meta.get(ids.frequent).useCount, 9)
  assert.equal(runtime.meta.get(ids.pinned).useCount, 1)
  // memory_replace also counts as used.
  await runtime.replace({ id: ids.old, text: 'pnpm 约定：改过一次' })
  assert.equal(runtime.meta.get(ids.old).useCount, 2)
  await runtime.stop()
})

test('pinned stays on top even after months of silence', async () => {
  const { runtime, clock, ids } = await scenario()
  // Jump six months later without touching anything.
  clock.ms = Date.UTC(2027, 3, 22, 7, 0, 0)
  const found = await runtime.search({ query: 'pnpm 约定', limit: 8, waitMs: 0, markUsed: false })
  assert.equal(found.ok, true, found.error)
  const order = found.hits.map((hit) => hit.id)
  assert.equal(order[2], ids.old)
  assert.equal(order[1], ids.frequent)
  assert.equal(order[0], ids.pinned, `pinned should win after long silence, got ${order.join(' > ')}`)
  await runtime.stop()
})
