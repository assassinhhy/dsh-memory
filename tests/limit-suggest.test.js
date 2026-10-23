import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { suggestForLimit } from '../packages/dsh-memory/src/limit-suggest.js'
import { createStore } from '../packages/dsh-memory/src/store.js'
import { formatFailure } from '../packages/dsh-memory/src/format.js'

const ITEMS = [
  { id: 'l-date', kind: 'item', text: '2026-10-22 修好了那个启动 bug，踩坑记录一下', chars: 24 },
  { id: 'l-simA', kind: 'item', text: '默认包管理器是 pnpm，安装依赖都走它，不要用 npm 或 yarn', chars: 30 },
  { id: 'l-simB', kind: 'item', text: '默认包管理器是 pnpm，安装依赖都走它，不要用 npm 或 yarn呀', chars: 31 },
  { id: 'l-short', kind: 'item', text: '短句而已', chars: 4 },
  { id: 'l-long', kind: 'item', text: '很长的叙述。'.repeat(20), chars: 120 },
]

const NOW_MS = Date.UTC(2026, 9, 22)

function metaWith(pinned = [], used = {}) {
  return (id) => ({
    pinned: pinned.includes(id),
    lastUsedAt: used[id] ?? 0,
    useCount: used[id] ? 1 : 0,
  })
}

test('suggestForLimit groups toJournal / merge / trim with id, chars, preview, reason', () => {
  const s = suggestForLimit(ITEMS, {
    getMeta: metaWith(),
    excludeIds: [],
    incoming: 200,
    limit: 400,
    used: 600,
    maxPerGroup: 3,
  })
  assert.ok(s.toJournal.length > 0)
  assert.ok(s.merge.length > 0)
  assert.ok(s.trim.length > 0)

  for (const group of [s.toJournal, s.trim]) {
    for (const item of group) {
      assert.equal(typeof item.id, 'string')
      assert.equal(typeof item.chars, 'number')
      assert.equal(typeof item.preview, 'string')
      assert.equal(typeof item.reason, 'string')
    }
  }
  for (const pair of s.merge) {
    assert.equal(pair.ids.length, 2)
    assert.ok(pair.similarity >= 0.3)
    assert.equal(typeof pair.reason, 'string')
  }

  // Date narrative and the long paragraph belong in the journal; the near-duplicates merge.
  assert.ok(s.toJournal.some((item) => item.id === 'l-date'))
  assert.ok(s.toJournal.some((item) => item.id === 'l-long'))
  assert.ok(s.merge.some((pair) => pair.ids.includes('l-simA') && pair.ids.includes('l-simB')))
  // trim is what is left over — never a member of a merge pair.
  assert.deepEqual(s.trim.map((item) => item.id), ['l-short'])

  assert.equal(s.incoming, 200)
  assert.equal(s.overflow, 200)
  // 120 + 24 journal, 30 merge drop, 4 trim — each drop counted once.
  assert.equal(s.freed, 120 + 24 + 30 + 4)
  assert.equal(s.enough, false)
})

test('pinned entries are never suggested, and neither is the entry being written', () => {
  const s = suggestForLimit(ITEMS, {
    getMeta: metaWith(['l-date', 'l-long', 'l-simA', 'l-simB', 'l-short']),
    incoming: 50,
    limit: 400,
    used: 450,
  })
  assert.deepEqual(s.toJournal, [])
  assert.deepEqual(s.merge, [])
  assert.deepEqual(s.trim, [])
  assert.equal(s.freed, 0)
  assert.equal(s.enough, false)

  const excluding = suggestForLimit(ITEMS, {
    getMeta: metaWith(),
    excludeIds: ['l-date', 'l-long'],
    incoming: 10,
    limit: 400,
    used: 410,
  })
  assert.equal(excluding.toJournal.some((item) => item.id === 'l-date'), false)
  assert.equal(excluding.toJournal.some((item) => item.id === 'l-long'), false)
})

test('use_count / last_used order the groups: longest-unused first', () => {
  const items = [
    { id: 'l-used', kind: 'item', text: '2026-10-01 旧的进度记录，今天又提了一次', chars: 20 },
    { id: 'l-stale', kind: 'item', text: '2026-10-02 更旧的进度记录，一直没再看过', chars: 20 },
  ]
  const s = suggestForLimit(items, {
    getMeta: metaWith([], { 'l-used': NOW_MS }),
    incoming: 5,
    limit: 10,
    used: 45,
    maxPerGroup: 3,
  })
  assert.deepEqual(s.toJournal.map((item) => item.id), ['l-stale', 'l-used'])
})

test('formatFailure lays the groups out in Chinese with an estimate line', () => {
  const s = suggestForLimit(ITEMS, {
    getMeta: metaWith(),
    incoming: 500,
    limit: 400,
    used: 900,
  })
  const text = formatFailure({
    ok: false,
    code: 'over_limit',
    error: 'MEMORY.md 写入后将达到 900 字符，上限 400。已拒绝写入，没有截断。',
    suggestions: s,
  })
  assert.match(text, /可挪去日记/)
  assert.match(text, /可合并的相似条目/)
  assert.match(text, /可精简的长条目/)
  assert.match(text, /释放约/)
  assert.match(text, /不会自动删除/)
})

test('over-limit write is refused whole, with groups and an estimate — the file is untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-cap-'))
  await writeFile(join(root, 'MEMORY.md'), [
    '# MEMORY.md',
    '',
    '- 2026-10-22 今天排查了启动问题，踩坑记录一下',
    '- 默认包管理器是 pnpm，安装依赖都走它，不要用 npm 或 yarn',
    '- 默认包管理器是 pnpm，安装依赖都走它，不要用 npm 或 yarn呀',
    '- 源码在 D:\\Tool\\deepseek-harness',
  ].join('\n') + '\n', 'utf8')
  const store = createStore({ root, idFactory: () => 'e-big01' })
  const before = (await store.list('memory')).entries.map((entry) => entry.id)

  const denied = await store.add({ target: 'memory', text: '新'.repeat(8000) })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'over_limit')
  assert.match(denied.error, /没有截断/)
  const groups = denied.suggestions
  assert.ok(groups.toJournal.length + groups.merge.length + groups.trim.length > 0)
  assert.ok(groups.merge.some((pair) => pair.ids.length === 2))
  assert.equal(typeof groups.freed, 'number')
  assert.equal(typeof groups.enough, 'boolean')
  // Nothing moved, nothing truncated.
  const after = (await store.list('memory')).entries.map((entry) => entry.id)
  assert.deepEqual(after, before)

  const text = formatFailure(denied)
  assert.match(text, /释放约 \d+ 字/)
  assert.match(text, /足以写入本次|仍不够本次/)
})
