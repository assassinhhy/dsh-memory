/**
 * M2 smoke (acceptance, 2026-10-22): decay ranking, mock consolidation, archive.
 *
 * Drives src/runtime.js + src/consolidate.js against a temporary DSH_HOME with
 * fake old / frequent / pinned entries, so the official USER.md / MEMORY.md /
 * journal are never touched (the script also snapshots them before and after).
 * The consolidation model call is mocked — no real API, no network.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConsolidation } from '../packages/dsh-memory/src/consolidate.js'
import { createRuntime } from '../packages/dsh-memory/src/runtime.js'
import { resolveMemoryRoot } from '../packages/dsh-memory/src/paths.js'

const officialRoot = resolveMemoryRoot()
const bareOfficial = join(homedir(), '.dsh', 'memory')
const officialFiles = [join(officialRoot, 'USER.md'), join(officialRoot, 'MEMORY.md'), join(bareOfficial, 'USER.md'), join(bareOfficial, 'MEMORY.md')]

async function snapshotOfficial() {
  const out = new Map()
  for (const file of officialFiles) {
    out.set(file, await readFile(file, 'utf8').catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error))))
  }
  return out
}

const tempHome = await mkdtemp(join(tmpdir(), 'dsh-memory-m2-home-'))
const root = resolveMemoryRoot({ DSH_HOME: tempHome })
assert.notEqual(root, officialRoot, 'smoke must never target the official memory root')

const embedder = {
  status: () => ({ state: 'ready', model: 'stub' }),
  warmup() {},
  embed: async (texts) => texts.map(() => new Float32Array([0, 1])),
}

// Mutable clock: the decay math must depend on entry age, not on wall time.
const clock = { ms: Date.UTC(2026, 2, 1, 0, 0, 0) }
let n = 0
const runtime = createRuntime({
  root,
  embedder,
  embedEnabled: () => false,
  idFactory: () => `e-m2-${++n}`,
  now: () => new Date(clock.ms),
  scoring: () => ({ halfLifeDays: { user: 60, memory: 60, journal: 21 }, boost: 0.25 }),
})

let modelCalls = 0
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
  // Mock model: no real API. It even tries to stale the pinned entry on purpose.
  callModel: async () => {
    modelCalls += 1
    return JSON.stringify({
      suggestions: [
        { type: 'stale', ids: [ids.old, ids.pinned], reason: '长期未用' },
        { type: 'promote', text: '默认包管理器是 pnpm', target: 'memory', ids: ['p-j1'], reason: '日记里反复出现' },
      ],
    })
  },
  now: () => new Date(clock.ms),
  intervalDays: 7,
  maxBatchChars: 6000,
})

const steps = []
function record(name, ok, detail) {
  steps.push({ name, ok, detail })
  console.log(`STEP ${name} ${ok ? 'OK' : 'FAIL'} ${detail}`)
}

const ids = { old: null, pinned: null, frequent: null }
const before = await snapshotOfficial()

try {
  await runtime.start()
  record('runtime.start', true, `root=${root}`)

  // Old entry: created in March, never used again → decay sinks it.
  const old = await runtime.add({ target: 'memory', text: 'pnpm 约定：很旧的一条，一直没再用到' })
  assert.equal(old.ok, true, old.error)
  ids.old = old.id

  // Pinned entry: decay must never touch it.
  const pinned = await runtime.add({ target: 'memory', text: 'pnpm 约定：置顶的关键约定' })
  assert.equal(pinned.ok, true, pinned.error)
  ids.pinned = pinned.id
  const pin = await runtime.pin({ id: ids.pinned, pinned: true })
  assert.equal(pin.ok, true, pin.error)
  assert.equal(pin.pinned, true)

  // Frequent entry: created "today", used many times → use boost keeps it on top.
  clock.ms = Date.UTC(2026, 9, 22, 7, 0, 0)
  const frequent = await runtime.add({ target: 'memory', text: 'pnpm 约定：最近常用的条目' })
  assert.equal(frequent.ok, true, frequent.error)
  ids.frequent = frequent.id
  for (let i = 0; i < 8; i++) runtime.meta.markUsed([ids.frequent], { now: clock.ms })
  record('seed', true, `old=${ids.old} pinned=${ids.pinned} frequent=${ids.frequent}`)

  // memory_search must rank frequent > pinned > old, even though old was added first.
  const found = await runtime.search({ query: 'pnpm 约定', limit: 8, waitMs: 0, markUsed: false })
  assert.equal(found.ok, true, found.error)
  assert.equal(found.hits.length, 3)
  const order = found.hits.map((hit) => hit.id)
  assert.deepEqual(order, [ids.frequent, ids.pinned, ids.old], `wrong order: ${order.join(' > ')}`)
  assert.equal(found.hits[0].useCount, 8)
  assert.equal(found.hits[2].useCount, 0)
  assert.ok(found.hits[2].score < found.hits[1].score, 'old must score below pinned')
  record('memory_search order', true, order.join(' > '))

  // Returned hits count as used.
  const seen = await runtime.search({ query: 'pnpm 约定', limit: 8, waitMs: 0 })
  assert.equal(seen.ok, true, seen.error)
  assert.equal(runtime.meta.get(ids.old).useCount, 1)
  assert.equal(runtime.meta.get(ids.frequent).useCount, 9)
  record('use_count tracking', true, `old=1 frequent=9`)

  // One mock consolidation → review/2026-W43.json + .md.
  assert.equal((await consolidation.status()).due, true)
  const run = await consolidation.run({})
  assert.equal(run.ok, true, run.error)
  assert.equal(run.week, '2026-W43')
  assert.equal(modelCalls, 1, 'consolidation must be one bounded model call per batch')
  const json = JSON.parse(await readFile(join(root, 'review', '2026-W43.json'), 'utf8'))
  const md = await readFile(join(root, 'review', '2026-W43.md'), 'utf8')
  assert.ok(json.suggestions.length >= 1)
  assert.match(md, /整理建议 2026-W43/)
  const stale = json.suggestions.find((item) => item.type === 'stale')
  assert.ok(stale, 'no stale suggestion saved')
  // The model asked to stale the pinned entry too — it must have been filtered out.
  assert.deepEqual(stale.ids, [ids.old], `pinned leaked into stale: ${stale.ids.join(',')}`)
  assert.deepEqual(stale.droppedIds, [ids.pinned])
  assert.equal((await consolidation.status()).due, false, 'a run must clear the due flag')
  record('mock consolidation', true, `week=${run.week} file=review/${run.week}.json stale_ids=${stale.ids.join(',')}`)

  // Accept the stale suggestion via the settings/API path → archive, never delete.
  const decided = await consolidation.decide({ week: run.week, key: stale.key, action: 'accept' })
  assert.equal(decided.ok, true, decided.error)
  const afterArchive = await readFile(join(root, 'MEMORY.md'), 'utf8')
  assert.ok(!afterArchive.includes('很旧的一条'), 'archived entry still in MEMORY.md')
  assert.ok(afterArchive.includes('置顶的关键约定'), 'pinned entry must survive the archive')
  const archived = await runtime.listArchive()
  assert.equal(archived.length, 1)
  assert.equal(archived[0].id, ids.old)
  assert.equal(archived[0].from, 'MEMORY.md')
  record('accept stale → archive', true, `id=${archived[0].id} archive=${archived[0].archivePath}`)

  // Restorable — this is not a hard delete.
  const restored = await runtime.restore({ id: ids.old })
  assert.equal(restored.ok, true, restored.error)
  const back = await readFile(join(root, 'MEMORY.md'), 'utf8')
  assert.ok(back.includes('很旧的一条'), 'restore did not bring the entry back')
  assert.equal((await runtime.listArchive()).length, 0, 'archive record must be consumed by restore')
  const twice = await consolidation.decide({ week: run.week, key: stale.key, action: 'accept' })
  assert.equal(twice.ok, false)
  assert.equal(twice.code, 'already_decided')
  record('restore', true, `id=${ids.old} back_in=MEMORY.md already_decided=${twice.code}`)

  // The real memory files were never lost or rewritten.
  const after = await snapshotOfficial()
  for (const file of officialFiles) {
    assert.equal(after.get(file), before.get(file), `official file changed: ${file}`)
  }
  record('official files untouched', true, `${officialRoot} unchanged`)
  await runtime.stop()

  const leftovers = await readdir(root).catch(() => [])
  console.log(`TEMP_ROOT ${root} leftover_files=${JSON.stringify(leftovers)}`)
  console.log(`RESULT ${JSON.stringify({ ok: true, steps: steps.length, order, week: run.week, tempHome })}`)
} catch (error) {
  await runtime.stop().catch(() => {})
  console.log(`STEP smoke FAIL ${String(error?.message ?? error)}`)
  console.log(`RESULT ${JSON.stringify({ ok: false, error: String(error?.message ?? error), tempHome })}`)
  process.exitCode = 1
} finally {
  await rm(tempHome, { recursive: true, force: true }).catch(() => {})
}
