import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRuntime } from '../packages/dsh-memory/src/runtime.js'

test('runtime search ranks a vector synonym that FTS cannot see', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-rt-'))
  const embedder = {
    status: () => ({ state: 'ready', model: 'fake' }),
    warmup() {},
    async embed(texts) {
      return texts.map((text) => {
        if (String(text).includes('pnpm') || String(text).includes('包管理器')) return new Float32Array([1, 0])
        if (String(text).includes('第三方库') || String(text).includes('拉取')) return new Float32Array([0.95, 0.05])
        return new Float32Array([0, 1])
      })
    },
  }
  const runtime = createRuntime({
    root,
    embedder,
    idFactory: (() => { let n = 0; return () => `e-rt${++n}` })(),
  })
  await runtime.start()
  const added = await runtime.add({ target: 'memory', text: '默认包管理器是 pnpm' })
  assert.equal(added.ok, true, added.error)
  await runtime.add({ target: 'journal', text: '今天只是出去散步' })
  const found = await runtime.search({ query: '用哪种命令拉取第三方库', waitMs: 0 })
  assert.equal(found.ok, true, found.error)
  assert.equal(found.vector, true)
  assert.equal(found.hits[0].text.includes('pnpm'), true)
  await runtime.stop()
})

test('a rename chain keeps each entry’s counters when ids collide', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-rt-'))
  // 甲 and 乙 are distinct items; rewriting 甲 into 乙's text makes it claim
  // 乙's id and push 乙 down to `~2`. The counters must not cross over.
  await writeFile(join(root, 'MEMORY.md'), '- 甲条\n- 乙条\n', 'utf8')
  const embedder = {
    status: () => ({ state: 'ready', model: 'fake' }),
    warmup() {},
    async embed(texts) { return texts.map(() => new Float32Array([1, 0])) },
  }
  const runtime = createRuntime({ root, embedder })
  await runtime.start()
  const listed = await runtime.list('memory')
  const first = listed.entries.find((entry) => entry.text.includes('甲条'))
  const second = listed.entries.find((entry) => entry.text.includes('乙条'))
  assert.ok(first && second)
  assert.notEqual(first.id, second.id)

  runtime.meta.markUsed([first.id], { now: 1000 })
  runtime.meta.markUsed([first.id], { now: 2000 })
  runtime.meta.markUsed([second.id], { now: 3000 })

  const replaced = await runtime.replace({ id: first.id, text: '乙条' })
  assert.equal(replaced.ok, true, replaced.error)
  assert.equal(replaced.id, second.id, '重写后的甲应顶到乙原来的 id')
  assert.equal(replaced.previousId, first.id)

  // 甲's counters ride along to its new id (plus the edit itself counting as
  // "used"); 乙 keeps its own under `~2` and is not swallowed by the merge.
  const moved = runtime.meta.get(replaced.id)
  assert.equal(moved.useCount, 3, '甲的 2 次 + 这次改写 1 次')
  const survivor = runtime.meta.get(`${second.id}~2`)
  assert.equal(survivor.useCount, 1, '乙的计数不该被并进甲')
  assert.equal(survivor.lastUsedAt, 3000)
  assert.equal(runtime.meta.get(first.id), undefined, '旧 id 不留 orphan 行')
  await runtime.stop()
})
