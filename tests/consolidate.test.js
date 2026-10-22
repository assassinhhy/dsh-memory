import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  applySuggestion,
  buildDigest,
  createConsolidation,
  filterPinnedStale,
  isoWeek,
  parseSuggestions,
} from '../packages/dsh-memory/src/consolidate.js'
import { LIMITS } from '../packages/dsh-memory/src/paths.js'
import { createRuntime } from '../packages/dsh-memory/src/runtime.js'

const NOW = Date.UTC(2026, 9, 22, 7, 4, 0)

const fakeEmbedder = {
  status: () => ({ state: 'ready', model: 'fake' }),
  warmup() {},
  async embed(texts) {
    return texts.map(() => new Float32Array([1, 0]))
  },
}

async function harness({ callModel, clock } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-cons-'))
  let n = 0
  const runtime = createRuntime({
    root,
    embedder: fakeEmbedder,
    idFactory: () => `e-c${String(++n).padStart(2, '0')}`,
    now: () => new Date(clock ?? NOW),
    scoring: () => ({ halfLifeDays: { user: 60, memory: 60, journal: 21 }, boost: 0.25 }),
  })
  await runtime.start()
  const consolidation = createConsolidation({
    root,
    store: runtime.store,
    meta: {
      byId: () => runtime.meta?.byId() ?? new Map(),
      kvGet: (key) => runtime.meta?.kvGet(key),
      kvSet: (key, value) => runtime.meta?.kvSet(key, value),
    },
    actions: {
      archive: (input) => runtime.archive(input),
      replace: (input) => runtime.replace(input),
      add: (input) => runtime.add(input),
    },
    callModel: callModel ?? (async () => '{"suggestions":[]}'),
    now: () => new Date(clock ?? NOW),
    intervalDays: 7,
    maxBatchChars: 6000,
  })
  return { root, runtime, consolidation }
}

test('digest feeds summaries + metadata only, and batches past the threshold', () => {
  const longA = '记住'.repeat(120)
  const longB = '今天'.repeat(120)
  const longC = '还有'.repeat(120)
  const entries = [
    { id: 'e-a', file: 'memory', text: longA, tags: '', pinned: true, useCount: 2, createdAt: NOW, lastUsedAt: null },
    { id: 'e-b', file: 'journal', text: longB, tags: '', pinned: false, useCount: 0, createdAt: NOW, lastUsedAt: NOW },
    { id: 'e-c', file: 'memory', text: longC, tags: 'x', pinned: false, useCount: 0, createdAt: NOW, lastUsedAt: null },
  ]
  const batches = buildDigest(entries, { maxChars: 600 })
  assert.ok(batches.length >= 2, `expected batching, got ${batches.length}`)
  const all = batches.map((batch) => batch.text).join('\n')
  assert.match(all, /pinned=true/)
  assert.match(all, /uses=2/)
  assert.match(all, /last_used=/)
  // Excerpts only — the 240-char bodies never travel.
  assert.equal(all.includes(longA), false)
  assert.equal(all.includes(longB), false)
  assert.equal(all.includes(longC), false)
  assert.ok(batches[0].ids.length > 0)
})

test('suggestion schema fails closed: bad items dropped, valid kept', () => {
  assert.deepEqual(parseSuggestions('not json').suggestions, [])
  assert.deepEqual(parseSuggestions('{"suggestions":{}}').suggestions, [])
  const parsed = parseSuggestions(`{
    "suggestions": [
      {"type":"stale","ids":["e-a"]},
      {"type":"stale","ids":[]},
      {"type":"merge","ids":["e-a"],"text":"只有一个是不够的"},
      {"type":"merge","ids":["e-a","e-b"],"text":"合并后的文本","reason":"重复"},
      {"type":"promote","text":"值得常驻","target":"memory","ids":["p-1"]},
      {"type":"promote","text":"目标错了","target":"journal"},
      {"type":"conflict","ids":["e-a","e-b"],"reason":"互相矛盾"},
      {"type":"conflict","ids":["e-a"]},
      {"type":"unknown","ids":["e-a"]}
    ]
  }`)
  assert.deepEqual(parsed.suggestions.map((item) => item.type), ['stale', 'merge', 'promote', 'conflict'])
  assert.equal(parsed.suggestions[1].text, '合并后的文本')
  assert.equal(parsed.suggestions[3].text, undefined)
})

test('pinned entries are dropped from stale suggestions only', () => {
  const { suggestions, dropped } = filterPinnedStale([
    { type: 'stale', ids: ['e-pinned', 'e-old'], reason: '很久没用' },
    { type: 'stale', ids: ['e-pinned'], reason: '全是置顶' },
    { type: 'merge', ids: ['e-pinned', 'e-x'], text: '合并' },
    { type: 'conflict', ids: ['e-pinned', 'e-y'], reason: '矛盾' },
  ], (id) => id === 'e-pinned')
  assert.deepEqual(suggestions.map((item) => item.type), ['stale', 'merge', 'conflict'])
  assert.deepEqual(suggestions[0].ids, ['e-old'])
  assert.deepEqual(suggestions[0].droppedIds, ['e-pinned'])
  assert.equal(dropped.length, 2)
})

test('mock consolidation writes review/YYYY-Www.json and the readable .md', async () => {
  const week = isoWeek(new Date(NOW))
  assert.equal(week, '2026-W43')
  const { root, runtime, consolidation } = await harness({
    callModel: async () => JSON.stringify({
      suggestions: [
        { type: 'stale', ids: ['e-c01'], reason: '长期未用' },
        { type: 'promote', text: '默认包管理器是 pnpm', target: 'memory', ids: ['p-1'], reason: '日记里反复出现' },
      ],
    }),
  })
  await runtime.add({ target: 'memory', text: '一条快过时的记录' })
  const result = await consolidation.run({})
  assert.equal(result.ok, true, result.error)
  assert.equal(result.week, week)
  const json = JSON.parse(await readFile(join(root, 'review', `${week}.json`), 'utf8'))
  assert.equal(json.week, week)
  assert.ok(json.suggestions.some((item) => item.type === 'stale' && item.status === 'pending'))
  assert.ok(json.suggestions.some((item) => item.type === 'promote'))
  const md = await readFile(join(root, 'review', `${week}.md`), 'utf8')
  assert.match(md, /整理建议 2026-W43/)
  assert.match(md, /过时/)
  // last-run recorded → not due again right away
  const status = await consolidation.status()
  assert.equal(status.due, false)
  assert.equal(status.lastAt, NOW)
})

test('pinned entries never land in stale, even when the model asks', async () => {
  const { runtime, consolidation } = await harness({
    callModel: async () => JSON.stringify({
      suggestions: [{ type: 'stale', ids: ['e-c01', 'e-c02'], reason: '都过时了' }],
    }),
  })
  await runtime.add({ target: 'user', text: '画像：主人' })
  await runtime.add({ target: 'memory', text: '普通记忆' })
  const ids = (await runtime.list('user')).entries.map((entry) => entry.id)
    .concat((await runtime.list('memory')).entries.map((entry) => entry.id))
  const [userEntry, memEntry] = ids
  const result = await consolidation.run({})
  const stale = result.suggestions.find((item) => item.type === 'stale')
  // The model named both ids; the pinned USER entry must be filtered out.
  const listed = await consolidation.list()
  const pendingStale = listed.filter((item) => item.type === 'stale')
  assert.equal(pendingStale.length, 1)
  assert.deepEqual(pendingStale[0].ids, [memEntry])
  assert.deepEqual(pendingStale[0].droppedIds, [userEntry])
  assert.equal(stale.droppedIds.includes(userEntry), true)
})

test('accepting a stale suggestion archives the entry, and restore brings it back', async () => {
  const week = isoWeek(new Date(NOW))
  const { root, runtime, consolidation } = await harness({
    callModel: async () => JSON.stringify({
      suggestions: [{ type: 'stale', ids: ['e-c01'], reason: '长期未用' }],
    }),
  })
  await runtime.add({ target: 'memory', text: '要归档的条目' })
  const before = await readFile(join(root, 'MEMORY.md'), 'utf8')
  await consolidation.run({})
  const decided = await consolidation.decide({ week, key: 's-1', action: 'accept' })
  assert.equal(decided.ok, true, decided.error)
  const afterArchive = await readFile(join(root, 'MEMORY.md'), 'utf8')
  assert.equal(afterArchive.includes('要归档的条目'), false)
  const archived = await runtime.listArchive()
  assert.equal(archived.length, 1)
  assert.equal(archived[0].id, 'e-c01')
  assert.equal(archived[0].from, 'MEMORY.md')
  assert.ok(archived[0].archivePath.includes('archive'))
  // Restorable — this is not a hard delete.
  const restored = await runtime.restore({ id: 'e-c01' })
  assert.equal(restored.ok, true, restored.error)
  const back = await readFile(join(root, 'MEMORY.md'), 'utf8')
  assert.ok(back.includes('要归档的条目'))
  assert.equal((await runtime.listArchive()).length, 0)
  // Decide state is recorded: cannot accept twice.
  const again = await consolidation.decide({ week, key: 's-1', action: 'accept' })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'already_decided')
  assert.equal(before.includes('要归档的条目'), true)
})

test('merge over the character cap is refused and nothing is truncated', async () => {
  const { root, runtime } = await harness()
  const first = await runtime.add({ target: 'memory', text: 'e1-first kept text' })
  const second = await runtime.add({ target: 'memory', text: 'e2-short' })
  assert.equal(first.ok, true, first.error)
  assert.equal(second.ok, true, second.error)
  const ids = (await runtime.list('memory')).entries.filter((entry) => entry.kind === 'entry').map((entry) => entry.id)
  assert.equal(ids.length, 2)
  const big = '合'.repeat(LIMITS.memory + 1)
  const applied = await applySuggestion(
    { type: 'merge', ids, text: big },
    { actions: { archive: (input) => runtime.archive(input), replace: (input) => runtime.replace(input), add: (input) => runtime.add(input) } },
  )
  assert.equal(applied.ok, false)
  assert.equal(applied.code, 'over_limit')
  assert.match(applied.error, /没有截断/)
  // Refused, not truncated: both original entries are still there.
  const text = await readFile(join(root, 'MEMORY.md'), 'utf8')
  assert.ok(text.includes('e2-short'))
  assert.ok(text.includes('e1-first kept text'))
})

test('merge keeps one id and archives the absorbed ones; promote respects the cap', async () => {
  const { runtime, consolidation } = await harness()
  await runtime.add({ target: 'memory', text: '第一条记忆' })
  await runtime.add({ target: 'memory', text: '第一条记忆（重复）' })
  const ids = (await runtime.list('memory')).entries.filter((entry) => entry.kind === 'entry').map((entry) => entry.id)
  const actions = {
    archive: (input) => runtime.archive(input),
    replace: (input) => runtime.replace(input),
    add: (input) => runtime.add(input),
  }
  const merged = await applySuggestion({ type: 'merge', ids, text: '合并后的记忆' }, { actions })
  assert.equal(merged.ok, true, merged.error)
  assert.equal(merged.kept, ids[0])
  assert.deepEqual(merged.archived, [ids[1]])
  const listed = await runtime.list('memory')
  assert.equal(listed.entries.filter((entry) => entry.kind === 'entry').length, 1)
  assert.ok(listed.entries.some((entry) => entry.text === '合并后的记忆'))

  const conflictNoText = await applySuggestion({ type: 'conflict', ids: [ids[0], ids[1]] }, { actions })
  assert.equal(conflictNoText.ok, false)
  assert.equal(conflictNoText.code, 'needs_text')

  const filled = 'm'.repeat(LIMITS.memory)
  const promote = await applySuggestion({ type: 'promote', target: 'memory', text: filled }, { actions })
  assert.equal(promote.ok, false)
  assert.equal(promote.code, 'over_limit')
})

test('edit-then-accept applies the edited text; reject-all clears the queue', async () => {
  const week = isoWeek(new Date(NOW))
  const { root, runtime, consolidation } = await harness({
    callModel: async () => JSON.stringify({
      suggestions: [
        { type: 'promote', text: '原文建议', target: 'memory', ids: [], reason: '反复出现' },
        { type: 'stale', ids: ['e-c02'], reason: '过时' },
      ],
    }),
  })
  await runtime.add({ target: 'journal', text: '今天的事件' })
  await consolidation.run({})
  const edited = await consolidation.decide({ week, key: 's-1', action: 'accept', text: '编辑后的文本' })
  assert.equal(edited.ok, true, edited.error)
  const memory = await readFile(join(root, 'MEMORY.md'), 'utf8')
  assert.ok(memory.includes('编辑后的文本'))
  assert.equal(memory.includes('原文建议'), false)

  const rejected = await consolidation.rejectAll({})
  assert.equal(rejected.rejected, 1)
  const listed = await consolidation.list()
  assert.equal(listed.filter((item) => item.status === 'pending').length, 0)
  assert.equal(listed.find((item) => item.key === 's-2').status, 'rejected')
})

test('consolidation is due again only after the interval', async () => {
  const { consolidation } = await harness({ callModel: async () => '{"suggestions":[]}' })
  assert.equal((await consolidation.status()).due, true)
  await consolidation.run({})
  const status = await consolidation.status()
  assert.equal(status.due, false)
  assert.equal(status.lastAt, NOW)
  assert.equal(status.nextAt, NOW + 7 * 86400000)
  assert.equal(status.intervalDays, 7)
})
