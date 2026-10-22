import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { detectKeyFact, keyFactLabel } from '../packages/dsh-memory/src/keyfact.js'
import { createRuntime } from '../packages/dsh-memory/src/runtime.js'

const NOW = Date.UTC(2026, 9, 22, 7, 4, 0)

const fakeEmbedder = {
  status: () => ({ state: 'ready', model: 'fake' }),
  warmup() {},
  async embed(texts) {
    return texts.map(() => new Float32Array([1, 0]))
  },
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-pin-'))
  await writeFile(join(root, 'MEMORY.md'), '# MEMORY.md\n\n- 源码在 D:\\Tool\\deepseek-harness\n', 'utf8')
  let n = 0
  const runtime = createRuntime({
    root,
    embedder: fakeEmbedder,
    idFactory: () => `e-p${String(++n).padStart(2, '0')}`,
    now: () => new Date(NOW),
  })
  await runtime.start()
  return { root, runtime }
}

test('detectKeyFact: hostnames, ports, paths, urls, ips and accounts', () => {
  assert.deepEqual(detectKeyFact('主机名 DESKTOP-ABC123').kinds, ['hostname'])
  assert.deepEqual(detectKeyFact('打印机在 PrintBox.local').kinds, ['hostname'])
  assert.deepEqual(detectKeyFact('代理端口 7890').kinds, ['port'])
  assert.deepEqual(detectKeyFact('监听在 :7890').kinds, ['port'])
  assert.deepEqual(detectKeyFact('port 8080 开着').kinds, ['port'])
  assert.deepEqual(detectKeyFact('代码在 D:\\Tool\\deepseek-harness').kinds, ['path'])
  assert.deepEqual(detectKeyFact('配置在 ~/.dsh/config.yaml').kinds, ['path'])
  assert.deepEqual(detectKeyFact('家目录 /home/gabi/.dsh').kinds, ['path'])
  assert.deepEqual(detectKeyFact('站点 https://example.com/x').kinds, ['url'])
  assert.deepEqual(detectKeyFact('域名 example.com').kinds, ['url'])
  assert.deepEqual(detectKeyFact('内网 192.168.1.10').kinds, ['ip'])
  assert.deepEqual(detectKeyFact('邮箱 me@example.com').kinds, ['account'])
  assert.deepEqual(detectKeyFact('仓库 github.com/torankusu').kinds, ['account'])
  assert.deepEqual(detectKeyFact('@betty 管本机').kinds, ['account'])

  // Multiple facts at once.
  assert.deepEqual(detectKeyFact('本机 DESKTOP-ABC123，代理端口 7890').kinds, ['hostname', 'port'])
})

test('detectKeyFact: plain prose and secrets produce no kinds', () => {
  assert.deepEqual(detectKeyFact('今天心情不错，继续写插件。').kinds, [])
  assert.deepEqual(detectKeyFact('').kinds, [])
  assert.deepEqual(detectKeyFact('api_key=sk-live-' + 'z'.repeat(24)).kinds, [])
  assert.deepEqual(detectKeyFact('token: ghp_' + 'a'.repeat(20)).kinds, [])
  assert.deepEqual(detectKeyFact('password=hunter2').kinds, [])
  assert.deepEqual(detectKeyFact('版本 10.0.19045 发布了').kinds, [])
  // `export=123` must not read as a port just because it contains "port".
  assert.deepEqual(detectKeyFact('export=12345').kinds, [])
})

test('keyFactLabel renders the Chinese hint line', () => {
  assert.equal(keyFactLabel(['port', 'path']), '端口/路径')
  assert.equal(keyFactLabel([]), '')
})

test('runtime suggests pinning a key fact in MEMORY.md and never pins by itself', async () => {
  const { runtime } = await harness()
  const added = await runtime.add({ target: 'memory', text: '本机代理端口 7890' })
  assert.equal(added.ok, true, added.error)
  assert.deepEqual(added.suggestPin, { id: 'e-p01', kinds: ['port'] })
  // Suggestion only — the entry stays unpinned until memory_pin runs.
  assert.equal(runtime.meta.get('e-p01').pinned, false)
  assert.equal((await runtime.list('memory')).entries.find((entry) => entry.id === 'e-p01').pinned, false)

  const pinned = await runtime.pin({ id: 'e-p01', pinned: true })
  assert.equal(pinned.ok, true, pinned.error)
  const again = await runtime.replace({ id: 'e-p01', text: '代理端口 7891' })
  assert.equal(again.ok, true, again.error)
  assert.equal(again.suggestPin, undefined, '已置顶的条目不再建议置顶')
})

test('runtime does not suggest pinning plain text or USER.md entries', async () => {
  const { runtime } = await harness()
  const plain = await runtime.add({ target: 'memory', text: '记得每周整理一次记忆' })
  assert.equal(plain.ok, true, plain.error)
  assert.equal(plain.suggestPin, undefined)

  // USER.md is pinned by default, so a key fact there is already covered.
  const user = await runtime.add({ target: 'user', text: '主机名 DESKTOP-ABC123' })
  assert.equal(user.ok, true, user.error)
  assert.equal(user.suggestPin, undefined)
  assert.equal(runtime.meta.get('e-p02').pinned, true)
})

test('replace of an l- item can raise the pin suggestion on the new id', async () => {
  const { runtime } = await harness()
  const listed = await runtime.list('memory')
  const target = listed.entries.find((entry) => entry.text.includes('D:\\Tool\\deepseek-harness'))
  assert.ok(target, '种子条目应该能被 list 找到')
  assert.equal(target.pinned, false, 'MEMORY.md 种子默认不置顶')

  const replaced = await runtime.replace({ id: target.id, text: '源码在 D:\\Tool\\deepseek-harness，构建输出在 D:\\Tool\\deepseek-harness\\dist' })
  assert.equal(replaced.ok, true, replaced.error)
  assert.equal(replaced.previousId, target.id)
  assert.deepEqual(replaced.suggestPin, { id: replaced.id, kinds: ['path'] })
  assert.equal(runtime.meta.get(replaced.id).pinned, false)
})
