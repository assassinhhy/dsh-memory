import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { unifiedDiff } from '../packages/dsh-memory/src/diff.js'
import {
  eachItem,
  listItems,
  removeItem,
  replaceItem,
  splitProse,
} from '../packages/dsh-memory/src/document.js'
import { chunksFrom } from '../packages/dsh-memory/src/index-db.js'
import { createStore } from '../packages/dsh-memory/src/store.js'

const MIXED = `# 标题

- 甲
- 乙
  续行
- 丙

段落一。

段落二。
`

function kinds(text) {
  return splitProse(text).map((part) => part.kind)
}

function ids(text) {
  return listItems(text).map((item) => item.id)
}

async function seeded(memoryText) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-entry-'))
  await writeFile(join(root, 'MEMORY.md'), memoryText, 'utf8')
  let n = 0
  const store = createStore({
    root,
    now: () => new Date('2026-10-22T07:04:00Z'),
    idFactory: () => `e-test${String(++n).padStart(2, '0')}`,
  })
  return { root, store }
}

test('splitProse: list items absorb continuations and sub-items, prose splits on blank lines', () => {
  assert.deepEqual(kinds(MIXED), ['prose', 'item', 'item', 'item', 'prose', 'prose'])
  const parts = splitProse(MIXED)
  assert.equal(parts[0].text, '# 标题')
  assert.equal(parts[1].text, '- 甲')
  assert.equal(parts[2].text, '- 乙\n  续行')
  assert.equal(parts[3].text, '- 丙')
  assert.equal(parts[4].text, '段落一。')
  assert.equal(parts[5].text, '段落二。')

  // Sub-items stay inside their parent; a deeper indented continuation too.
  const nested = splitProse('- 父\n  - 子\n  还是子\n\n- 兄\n')
  assert.deepEqual(nested.map((part) => part.kind), ['item', 'item'])
  assert.equal(nested[0].text, '- 父\n  - 子\n  还是子')

  // A loose list keeps its item open across a blank line when the next line is deeper.
  const loose = splitProse('- 条\n\n  续\n\n- 另\n')
  assert.deepEqual(loose.map((part) => part.kind), ['item', 'item'])
  assert.equal(loose[0].text, '- 条\n\n  续')

  // `---` / `-foo` are not list items.
  assert.deepEqual(kinds('---\n\n-foo\n'), ['prose', 'prose'])
})

test('ids are content hashes: unrelated insert / delete / edit keeps the others', () => {
  const base = ids('- A\n- B\n- C\n')
  assert.equal(base.length, 3)
  assert.ok(base.every((id) => id.startsWith('l-')))

  // Insert before / after — no other id moves.
  assert.deepEqual(ids('- 新\n- A\n- B\n- C\n').slice(1), base)
  assert.deepEqual(ids('- A\n- B\n- C\n- 新\n').slice(0, 3), base)

  // Delete a neighbour — no other id moves.
  assert.deepEqual(ids('- A\n- B\n'), base.slice(0, 2))
  assert.deepEqual(ids('- A\n- C\n'), [base[0], base[2]])

  // Edit another item — no other id moves.
  const edited = ids('- A\n- B改\n- C\n')
  assert.equal(edited[0], base[0])
  assert.notEqual(edited[1], base[1])
  assert.equal(edited[2], base[2])

  // Editing an item only changes that item's own id.
  assert.notEqual(ids('- A改\n- B\n- C\n')[0], base[0])
})

test('identical duplicates get ~2 suffixes and keep them among themselves', () => {
  const dup = listItems('- 同\n- 同\n- 异\n- 同\n')
  assert.deepEqual(dup.map((item) => item.id), [dup[0].id, `${dup[0].id}~2`, dup[2].id, `${dup[0].id}~3`])
  assert.ok(dup[0].id.startsWith('l-'))
  assert.notEqual(dup[0].id, dup[2].id)
})

test('replaceItem / removeItem touch only that item’s bytes', () => {
  const raw = '# 头\n\n- 甲\n- 乙\n- 丙\n\n尾\n'
  const items = eachItem(raw)
  const yi = items.find((item) => item.text === '- 乙')
  assert.ok(yi)

  assert.equal(replaceItem(raw, yi, '乙改'), '# 头\n\n- 甲\n- 乙改\n- 丙\n\n尾\n')
  // A replacement that itself contains a list marker is re-marked under the same prefix.
  assert.equal(replaceItem(raw, yi, '- 乙改\n  多行'), '# 头\n\n- 甲\n- 乙改\n  多行\n- 丙\n\n尾\n')
  assert.equal(removeItem(raw, yi), '# 头\n\n- 甲\n- 丙\n\n尾\n')

  // Trailing entry: drop its blank separator too.
  assert.equal(removeItem(raw, items.find((item) => item.text === '- 丙')), '# 头\n\n- 甲\n- 乙\n尾\n')
})

test('store replace of an l- id returns the new id + diff and leaves the rest of the file alone', async () => {
  const raw = '# 头\n\n- 甲\n- 乙\n- 丙\n'
  const { root, store } = await seeded(raw)
  const listed = await store.list('memory')
  const before = listed.entries.map((entry) => entry.id)
  const yi = listed.entries.find((entry) => entry.text.includes('乙'))

  const result = await store.replace({ id: yi.id, text: '乙改' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.id, result.affectedIds[0])
  assert.equal(result.previousId, yi.id)
  assert.notEqual(result.id, yi.id)
  assert.ok(result.id.startsWith('l-'))
  assert.equal(result.id.length, 12)

  // Diff covers just the affected entry.
  assert.equal(result.diff.before, '- 乙')
  assert.equal(result.diff.after, '- 乙改')
  assert.ok(result.diff.text.includes('--- a/MEMORY.md'))
  assert.ok(result.diff.text.includes('+++ b/MEMORY.md'))
  assert.ok(result.diff.text.includes('@@'))
  assert.ok(result.diff.text.includes('乙改'))

  // Every other byte is preserved and every other id is unchanged.
  assert.equal(await readFile(join(root, 'MEMORY.md'), 'utf8'), '# 头\n\n- 甲\n- 乙改\n- 丙\n')
  assert.equal(yi.id, before[2], '种子条目顺序：标题 / 甲 / 乙 / 丙')
  const after = await store.list('memory')
  const afterIds = after.entries.map((entry) => entry.id)
  assert.deepEqual(afterIds, [before[0], before[1], result.id, before[3]])
})

test('store remove of an l- id splices only that line', async () => {
  const raw = '# 头\n\n- 甲\n- 乙\n- 丙\n'
  const { root, store } = await seeded(raw)
  const yi = (await store.list('memory')).entries.find((entry) => entry.text.includes('乙'))
  const result = await store.remove({ id: yi.id })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.id, yi.id)
  assert.deepEqual(result.affectedIds, [yi.id])
  assert.equal(await readFile(join(root, 'MEMORY.md'), 'utf8'), '# 头\n\n- 甲\n- 丙\n')
  assert.ok(result.diff.text.includes(yi.text))
})

test('anchor replace resolves to a real entry id, never null', async () => {
  const { store } = await seeded('# 头\n\n- 甲\n- 乙\n- 丙\n')
  const result = await store.replace({ anchor: '乙', text: '乙改' })
  assert.equal(result.ok, true, result.error)
  assert.ok(result.id, 'id 必须非空')
  assert.ok(result.id.startsWith('l-'))
  assert.equal(result.previousId?.startsWith('l-'), true)
  assert.deepEqual(result.affectedIds, [result.id])

  // Whole-line anchor removes the item, id still reported.
  const byRemove = await store.remove({ anchor: '- 丙' })
  assert.equal(byRemove.ok, true, byRemove.error)
  assert.ok(byRemove.id.startsWith('l-'))
  assert.deepEqual(byRemove.affectedIds, [byRemove.id])
})

test('unfenced stays a v0.1.0 whole-prose alias and never returns a null id', async () => {
  const raw = '正文一。\n\n<!-- dsh-mem id="e-old" tags="x" -->\n已有条目\n<!-- /dsh-mem -->\n'
  const { root, store } = await seeded(raw)
  const listed = await store.list('memory')
  assert.equal(listed.entries.some((entry) => entry.id.startsWith('p-')), true)

  const result = await store.replace({ id: 'unfenced', text: '正文二。' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.id, 'unfenced')
  assert.ok(result.affectedIds.length > 0)
  assert.ok(result.diff.after.includes('正文二。'))
  const after = await readFile(join(root, 'MEMORY.md'), 'utf8')
  assert.ok(after.includes('正文二。'))
  assert.ok(after.includes('<!-- dsh-mem id="e-old" tags="x" -->'), '标记条目必须原样保留')
  assert.ok(after.includes('已有条目'))

  const removed = await store.remove({ id: 'unfenced' })
  assert.equal(removed.ok, true, removed.error)
  assert.equal(removed.id, 'unfenced')
  const final = await readFile(join(root, 'MEMORY.md'), 'utf8')
  assert.equal(final.includes('正文二。'), false)
  assert.ok(final.includes('e-old'))
})

test('list, search chunks and meta share one id space', async () => {
  const raw = '# 头\n\n- 甲乙丙\n- 丁戊己\n\n段落庚辛壬。\n'
  const listedIds = listItems(raw).map((item) => item.id)
  const chunkIds = chunksFrom('memory', 'MEMORY.md', raw).map((chunk) => chunk.entryId)
  assert.deepEqual(chunkIds, listedIds)
  assert.ok(listedIds.some((id) => id.startsWith('l-')))
  assert.ok(listedIds.some((id) => id.startsWith('p-')))
  // Every chunk id round-trips through listItems.
  for (const id of chunkIds) {
    assert.ok(listItems(raw).some((item) => item.id === id))
  }
})

test('unified diff truncates long hunks with a note and stays empty when equal', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n'), '')
  const longBefore = Array.from({ length: 60 }, (_, i) => `旧${i}`).join('\n')
  const longAfter = Array.from({ length: 60 }, (_, i) => `新${i}`).join('\n')
  const text = unifiedDiff(longBefore, longAfter, { path: 'MEMORY.md', startLine: 1 })
  assert.ok(text.includes('--- a/MEMORY.md'))
  assert.ok(text.includes('diff 过长已截断'))
})
