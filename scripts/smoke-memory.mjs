/**
 * memory_* tool smoke (acceptance, 2026-10-22).
 *
 * Drives the same layer the memory_add / memory_search / memory_list /
 * memory_remove tool handlers call (src/runtime.js + src/format.js) against a
 * temporary DSH_HOME, so the official USER.md / MEMORY.md / journal are never
 * touched. Embeddings are stubbed (FTS path); the bge-m3 path is already
 * covered by scripts/smoke-embed.mjs and tests/runtime.test.js.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../packages/dsh-memory/src/runtime.js'
import { formatList, formatRemove, formatSearch, formatWrite } from '../packages/dsh-memory/src/format.js'
import { resolveMemoryRoot } from '../packages/dsh-memory/src/paths.js'

const MARKER = 'VERIFY_SMOKE_20261022'
const officialRoot = resolveMemoryRoot()

const tempHome = await mkdtemp(join(tmpdir(), 'dsh-memory-verify-home-'))
const root = resolveMemoryRoot({ DSH_HOME: tempHome })
assert.notEqual(root, officialRoot, 'smoke must never target the official memory root')
assert.equal(root, join(tempHome, 'memory'), 'DSH_HOME must map to memory/ underneath')

const embedder = {
  status: () => ({ state: 'ready', model: 'stub' }),
  warmup() {},
  embed: async (texts) => texts.map(() => new Float32Array([0, 1])),
}

const runtime = createRuntime({
  root,
  embedder,
  idFactory: (() => {
    let n = 0
    return () => `e-verify${++n}`
  })(),
})

const steps = []
function record(name, ok, detail) {
  steps.push({ name, ok, detail })
  console.log(`STEP ${name} ${ok ? 'OK' : 'FAIL'} ${detail}`)
}

try {
  await runtime.start()
  record('runtime.start', true, `root=${root}`)

  // memory_add
  const added = await runtime.add({
    target: 'memory',
    text: `${MARKER} 临时测试条目：默认包管理器是 pnpm（验收后删除，不入正式记忆）`,
    tags: 'verify-smoke',
  })
  assert.equal(added.ok, true, `memory_add failed: ${added.error ?? ''}`)
  assert.equal(added.target, 'memory')
  assert.match(String(added.id), /^e-verify/)
  record('memory_add', true, formatWrite(added))

  // memory_search (FTS)
  const found = await runtime.search({ query: '包管理器 pnpm', limit: 8, waitMs: 0 })
  assert.equal(found.ok, true, `memory_search failed: ${found.error ?? ''}`)
  const hit = found.hits.find((item) => String(item.text ?? '').includes(MARKER))
  assert.ok(hit, `memory_search did not return the ${MARKER} entry`)
  record('memory_search', true, formatSearch(found))

  // memory_list
  const listed = await runtime.list('memory')
  assert.equal(listed.ok, true)
  const entry = (listed.entries ?? []).find((item) => item.id === added.id)
  assert.ok(entry, 'memory_list does not show the added entry')
  record('memory_list', true, formatList(listed))

  // memory_remove
  const removed = await runtime.remove({ id: added.id, target: 'memory' })
  assert.equal(removed.ok, true, `memory_remove failed: ${removed.error ?? ''}`)
  record('memory_remove', true, formatRemove(removed))

  // memory_list after cleanup
  const after = await runtime.list('memory')
  const gone = !(after.entries ?? []).some((item) => item.id === added.id)
  assert.equal(gone, true, 'entry survived memory_remove')
  const body = await readFile(join(root, 'MEMORY.md'), 'utf8').catch(() => '')
  assert.ok(!body.includes(MARKER), 'marker text still present in MEMORY.md after removal')
  record('cleanup', true, `entries=${(after.entries ?? []).length} marker_in_file=${body.includes(MARKER)}`)

  await runtime.stop()
  const leftovers = await readdir(root).catch(() => [])
  console.log(`TEMP_ROOT ${root} leftover_files=${JSON.stringify(leftovers)}`)
  console.log(`RESULT ${JSON.stringify({ ok: true, steps: steps.length, marker: MARKER, tempHome: tempHome })}`)
} catch (error) {
  await runtime.stop().catch(() => {})
  console.log(`STEP smoke FAIL ${String(error?.message ?? error)}`)
  console.log(`RESULT ${JSON.stringify({ ok: false, error: String(error?.message ?? error), tempHome: tempHome })}`)
  process.exitCode = 1
} finally {
  await rm(tempHome, { recursive: true, force: true }).catch(() => {})
}
