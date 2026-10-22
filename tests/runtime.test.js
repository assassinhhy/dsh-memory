import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
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
