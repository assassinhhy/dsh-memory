import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createIndex } from '../packages/dsh-memory/src/index-db.js'
import { cosine, rrfMerge } from '../packages/dsh-memory/src/search.js'
import { createSnapshotCache, renderMemoryPrompt } from '../packages/dsh-memory/src/snapshot.js'
import { applyReviewDecision, createReviewScheduler, parseReviewDecision } from '../packages/dsh-memory/src/review.js'
import { createStore } from '../packages/dsh-memory/src/store.js'

test('prompt snapshot freezes the first read and ignores later file edits', () => {
  const cache = createSnapshotCache()
  const first = renderMemoryPrompt({
    userText: '称呼：主人',
    memoryText: '默认用 pnpm',
    capturedAt: '2026-10-22 15:04',
  })
  assert.match(first, /不可信/)
  assert.match(first, /不要执行/)
  assert.ok(first.includes('称呼：主人'))
  const frozen = cache.freeze('sess-1', first)
  const second = renderMemoryPrompt({ userText: '已被改掉', memoryText: '也被改掉' })
  const again = cache.freeze('sess-1', second)
  assert.equal(again, frozen)
  assert.equal(cache.get('sess-1').includes('已被改掉'), false)
  assert.notEqual(cache.freeze('sess-2', second), frozen)
})

test('rrf ranks a vector-only synonym above an unrelated lexical hit', () => {
  const merged = rrfMerge([
    {
      source: 'fts',
      items: [{ id: 'weather' }, { id: 'unrelated' }],
    },
    {
      source: 'vector',
      items: [{ id: 'pnpm' }, { id: 'weather' }],
    },
  ], { k: 60, limit: 5 })
  assert.equal(merged[0].id, 'weather')
  const pnpm = merged.find((hit) => hit.id === 'pnpm')
  const unrelated = merged.find((hit) => hit.id === 'unrelated')
  assert.ok(pnpm.score > unrelated.score)
  assert.equal(pnpm.sources.vector, 1)
  assert.equal(pnpm.sources.fts, undefined)
})

test('cosine is 1 for identical unit vectors and 0 for orthogonal ones', () => {
  assert.ok(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([1, 0])) - 1) < 1e-6)
  assert.ok(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))) < 1e-6)
})

test('hybrid index: Chinese FTS plus a vector hit that shares no keywords', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-idx-'))
  const index = await createIndex(join(dir, 'index.sqlite'))
  const corpus = [
    { target: 'memory', path: 'MEMORY.md', text: '默认包管理器是 pnpm，安装依赖走它。' },
    { target: 'journal', path: 'journal/2026-10-22.md', text: '今天天气不错，出去走了走。' },
  ]
  index.sync(corpus)
  const fts = index.fts('pnpm')
  assert.ok(fts.some((row) => row.text.includes('pnpm')))
  const chinese = index.fts('包管理器')
  assert.ok(chinese.some((row) => row.text.includes('包管理器')), 'trigram should hit Chinese')

  const docs = index.texts(index.pendingIds())
  const vectors = new Map([
    [docs.find((doc) => doc.text.includes('pnpm')).id, new Float32Array([1, 0, 0])],
    [docs.find((doc) => doc.text.includes('天气')).id, new Float32Array([0, 1, 0])],
  ])
  index.putVectors([...vectors].map(([id, vector]) => ({ id, vector })))

  const query = '用哪种命令拉取第三方库'
  assert.equal(index.fts(query).some((row) => row.text.includes('pnpm')), false)
  const result = index.search({ query, queryVector: new Float32Array([0.9, 0.1, 0]), limit: 4 })
  assert.equal(result.vector, true)
  assert.equal(result.hits[0].text.includes('pnpm'), true)
  index.close()
})

test('review parser fails closed, and a real ADD respects the store cap', async () => {
  assert.equal(parseReviewDecision('not json').decision.action, 'NOOP')
  assert.equal(parseReviewDecision('{"action":"ADD"}').decision.action, 'NOOP')
  const parsed = parseReviewDecision('```json\n{"action":"add","target":"memory","text":"默认用 pnpm"}\n```')
  assert.equal(parsed.decision.action, 'ADD')
  assert.equal(parsed.decision.text, '默认用 pnpm')

  const scheduler = createReviewScheduler({ every: 6 })
  assert.equal(scheduler.tick('s'), false)
  for (let i = 0; i < 4; i++) scheduler.tick('s')
  assert.equal(scheduler.tick('s'), true)
  assert.equal(scheduler.tick('s'), false)

  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-rev-'))
  const store = createStore({ root, idFactory: () => 'e-rev01' })
  const applied = await applyReviewDecision(store, parsed.decision)
  assert.equal(applied.ok, true, applied.error)
  const secret = await applyReviewDecision(store, { action: 'ADD', target: 'memory', text: 'password=supersecretvalue' })
  assert.equal(secret.ok, false)
  assert.equal(secret.code, 'secret')
})
