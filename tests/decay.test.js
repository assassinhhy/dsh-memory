import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_HALF_LIFE_DAYS,
  ageDays,
  combineScore,
  decayFactor,
  decayScore,
  halfLifeFor,
  rankHits,
  useFactor,
} from '../packages/dsh-memory/src/decay.js'

const DAY = 86400000
const NOW = Date.UTC(2026, 9, 22, 7, 0, 0)

test('decay halves at the half-life, pinned never decays', () => {
  assert.equal(decayFactor({ age: 0, halfLifeDays: 60, pinned: false }), 1)
  assert.equal(decayFactor({ age: 60, halfLifeDays: 60, pinned: false }), 0.5)
  assert.equal(decayFactor({ age: 120, halfLifeDays: 60, pinned: false }), 0.25)
  assert.equal(decayFactor({ age: 60, halfLifeDays: 60, pinned: true }), 1)
  assert.equal(decayFactor({ age: 10000, halfLifeDays: 60, pinned: true }), 1)
  // journal sinks twice as fast as memory
  assert.equal(decayFactor({ age: 21, halfLifeDays: 21, pinned: false }), 0.5)
  assert.equal(DEFAULT_HALF_LIFE_DAYS.memory, 60)
  assert.equal(DEFAULT_HALF_LIFE_DAYS.journal, 21)
  // a broken half-life must not divide by zero
  assert.equal(decayFactor({ age: 60, halfLifeDays: 0, pinned: false }), 1)
})

test('use_count adds a log2 boost', () => {
  assert.equal(useFactor(0), 1)
  assert.equal(useFactor(1), 1 + 0.25)
  assert.equal(useFactor(3), 1 + Math.log2(4) * 0.25)
  assert.equal(useFactor(8), 1 + Math.log2(9) * 0.25)
  assert.equal(useFactor(undefined), 1)
  assert.equal(useFactor(-4), 1)
})

test('age uses last_used first, falls back to created, clamps to zero', () => {
  const meta = { lastUsedAt: NOW - 10 * DAY, createdAt: NOW - 200 * DAY }
  assert.equal(ageDays(meta, NOW), 10)
  assert.equal(ageDays({ createdAt: NOW - 200 * DAY }, NOW), 200)
  assert.equal(ageDays({}, NOW), 0)
  assert.equal(ageDays({ lastUsedAt: NOW + DAY }, NOW), 0)
})

test('score = rrf × decay × (1 + log2(1+use_count) × 0.25)', () => {
  const meta = { file: 'memory', lastUsedAt: NOW - 60 * DAY, createdAt: NOW - 60 * DAY, useCount: 3, pinned: false }
  // decay 0.5, use factor 1.5 → 0.02 × 0.5 × 1.5
  assert.equal(combineScore({ rrf: 0.02, meta, now: NOW }), 0.02 * 0.5 * 1.5)
  const pinned = { ...meta, pinned: true }
  assert.equal(combineScore({ rrf: 0.02, meta: pinned, now: NOW }), 0.02 * 1 * 1.5)
  assert.equal(decayScore({ meta: pinned, now: NOW }), 1.5)
})

test('half-lives are per file with safe fallbacks', () => {
  assert.equal(halfLifeFor('journal'), 21)
  assert.equal(halfLifeFor('memory'), 60)
  assert.equal(halfLifeFor('memory', { memory: 30 }), 30)
  assert.equal(halfLifeFor('journal', { journal: -5 }), 21)
  assert.equal(halfLifeFor('memory', undefined), 60)
})

test('rankHits sinks an old unused entry below pinned and frequently used ones', () => {
  const metaById = new Map([
    ['old', { file: 'memory', createdAt: NOW - 200 * DAY, lastUsedAt: NOW - 200 * DAY, useCount: 0, pinned: false }],
    ['frequent', { file: 'memory', createdAt: NOW - 200 * DAY, lastUsedAt: NOW, useCount: 8, pinned: false }],
    ['pinned', { file: 'memory', createdAt: NOW - 200 * DAY, lastUsedAt: NOW - 200 * DAY, useCount: 0, pinned: true }],
  ])
  // 'old' even has the best raw rrf — decay must still sink it.
  const hits = [
    { id: 'old', score: 1 / 61 },
    { id: 'frequent', score: 1 / 62 },
    { id: 'pinned', score: 1 / 63 },
  ]
  const ranked = rankHits(hits, metaById, { now: NOW })
  assert.deepEqual(ranked.map((hit) => hit.id), ['frequent', 'pinned', 'old'])
  assert.equal(ranked[0].lastUsed, NOW)
  assert.equal(ranked[1].pinned, true)
  assert.ok(ranked[2].score < ranked[1].score)
  // hits without meta keep raw rrf
  const bare = rankHits([{ id: 'nobody', score: 0.5 }], new Map(), { now: NOW })
  assert.equal(bare[0].score, 0.5)
})
