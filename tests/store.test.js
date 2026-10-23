import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LIMITS } from '../packages/dsh-memory/src/paths.js'
import { createStore } from '../packages/dsh-memory/src/store.js'

const SEED = `# USER.md — 主人画像（种子）

- 称呼：主人（对话里不要叫真名）
- 时区：Asia/Shanghai（UTC+8）
- 分工：生活/本机 → 贝蒂（dsh）；编程工作 → 拉姆 + Claude Code
`

async function tempStore() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  await writeFile(join(root, 'USER.md'), SEED, 'utf8')
  await writeFile(join(root, 'MEMORY.md'), '# MEMORY.md\n\n- 源码在 D:\\Tool\\deepseek-harness\n', 'utf8')
  let n = 0
  const store = createStore({
    root,
    now: () => new Date('2026-10-22T07:04:00Z'),
    idFactory: () => `e-test${String(++n).padStart(2, '0')}`,
  })
  return { root, store }
}

test('add keeps the seed bytes and stamps an id', async () => {
  const { root, store } = await tempStore()
  const added = await store.add({ target: 'user', text: '记住我默认用 pnpm', tags: ['tooling'] })
  assert.equal(added.ok, true)
  assert.equal(added.id, 'e-test01')
  const after = await readFile(join(root, 'USER.md'), 'utf8')
  assert.ok(after.startsWith(SEED.trimEnd()) || after.includes('称呼：主人'))
  assert.ok(after.includes(SEED.trim()))
  assert.ok(after.includes('<!-- dsh-mem id="e-test01" tags="tooling" -->'))
  assert.ok(after.includes('记住我默认用 pnpm'))
  assert.equal(after.includes('AGENTS.md'), false)
})

test('refuses over the character cap without truncating or writing', async () => {
  const { root, store } = await tempStore()
  const filler = '记'.repeat(LIMITS.user)
  const denied = await store.add({ target: 'user', text: filler })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'over_limit')
  assert.match(denied.error, /没有截断/)
  // M3: 建议从平铺数组改为分组（toJournal/merge/trim），带 id+chars+preview+reason 和释放估算。
  assert.ok(denied.suggestions.toJournal.length + denied.suggestions.merge.length + denied.suggestions.trim.length > 0)
  assert.equal(typeof denied.suggestions.freed, 'number')
  assert.equal(denied.suggestions.incoming > 0, true)
  const after = await readFile(join(root, 'USER.md'), 'utf8')
  assert.equal(after, SEED)
})

test('memory cap is 8000 and user cap is 2000', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-cap-'))
  const store = createStore({ root, idFactory: () => 'e-cap01' })
  const ok = await store.add({ target: 'memory', text: 'a'.repeat(LIMITS.memory - 200) })
  assert.equal(ok.ok, true, ok.error)
  const denied = await store.add({ target: 'memory', text: 'b'.repeat(200) })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'over_limit')
  assert.match(denied.error, new RegExp(String(LIMITS.memory)))
  const userDenied = await store.add({ target: 'user', text: 'u'.repeat(2001) })
  assert.equal(userDenied.code, 'over_limit')
  assert.match(userDenied.error, /2000/)
})

test('secret write is refused and the file is unchanged', async () => {
  const { root, store } = await tempStore()
  const before = await readFile(join(root, 'MEMORY.md'), 'utf8')
  const denied = await store.add({ target: 'memory', text: 'api_key=sk-live-' + 'z'.repeat(24) })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'secret')
  assert.equal(denied.error.includes('sk-live'), false)
  assert.equal(await readFile(join(root, 'MEMORY.md'), 'utf8'), before)
})

test('replace and remove by id, and by a unique anchor in the seed', async () => {
  const { root, store } = await tempStore()
  const added = await store.add({ target: 'memory', text: '默认包管理器是 pnpm' })
  const replaced = await store.replace({ id: added.id, text: '默认包管理器是 pnpm，不要改成 npm' })
  assert.equal(replaced.ok, true, replaced.error)
  const listed = await store.list('memory')
  assert.ok(listed.entries.some((item) => item.id === added.id && item.text.includes('不要改成 npm')))
  const byAnchor = await store.replace({ anchor: '称呼：主人（对话里不要叫真名）', text: '称呼：主人' })
  assert.equal(byAnchor.ok, true, byAnchor.error)
  const user = await readFile(join(root, 'USER.md'), 'utf8')
  assert.ok(user.includes('称呼：主人'))
  assert.equal(user.includes('不要叫真名'), false)
  const removed = await store.remove({ id: added.id })
  assert.equal(removed.ok, true)
  const after = await store.list('memory')
  assert.equal(after.entries.some((item) => item.id === added.id), false)
})

test('ambiguous anchor does not write', async () => {
  const { root, store } = await tempStore()
  await writeFile(join(root, 'MEMORY.md'), '- pnpm\n- pnpm\n', 'utf8')
  const result = await store.replace({ anchor: 'pnpm', text: 'npm' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ambiguous')
  assert.equal(await readFile(join(root, 'MEMORY.md'), 'utf8'), '- pnpm\n- pnpm\n')
})

test('journal append lands in the Shanghai day file and is not capped', async () => {
  const { root, store } = await tempStore()
  const added = await store.add({ target: 'journal', text: '今天决定记忆插件用 FTS5 trigram' })
  assert.equal(added.ok, true, added.error)
  assert.ok(added.path.endsWith('journal\\2026-10-22.md') || added.path.endsWith('journal/2026-10-22.md'))
  const text = await readFile(added.path, 'utf8')
  assert.match(text, /2026-10-22/)
  assert.ok(text.includes('FTS5 trigram'))
  assert.equal(added.limit, null)
})

test('list reports character occupancy and does not create AGENTS.md', async () => {
  const { root, store } = await tempStore()
  const listed = await store.list('user')
  assert.equal(listed.limit, 2000)
  assert.equal(listed.used, SEED.length)
  // M3: 种子正文不再是一个 unfenced 大块，而是按条目拆开（l-/p- 内容哈希 id）。
  assert.equal(listed.entries.some((item) => item.id === 'unfenced'), false)
  assert.ok(listed.entries.some((item) => item.kind === 'item' && item.id.startsWith('l-') && item.text.includes('称呼：主人')))
  assert.ok(listed.entries.some((item) => item.kind === 'prose' && item.id.startsWith('p-')))
  for (const item of listed.entries) assert.ok(item.id, '每个条目都要有 id')
  await assert.rejects(readFile(join(root, '..', 'AGENTS.md'), 'utf8'))
})
