import assert from 'node:assert/strict'
import test from 'node:test'
import { formatSessionHits, runSessionSearch } from '../packages/dsh-memory/src/session-search.js'

test('session search keeps the official cwd fence and drops the caller session', async () => {
  const calls = []
  const engine = {
    async searchSessions(request) {
      calls.push(request)
      return {
        items: [
          { header: { id: 'self' }, bestMatch: { snippet: '自己的', time: 1 } },
          { header: { id: 'other' }, bestMatch: { snippet: '旧对话里有 pnpm', time: 2 } },
        ],
      }
    },
    async filterSessions() { throw new Error('should not authorize when searching all') },
    async searchEvents() { throw new Error('should not search events') },
  }
  const result = await runSessionSearch({
    sessionQuery: engine,
    caller: { id: 'self', cwd: 'D:\\Tool\\deepseek-harness' },
    query: 'pnpm',
  })
  assert.equal(result.ok, true)
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].header.id, 'other')
  assert.deepEqual(calls[0].sessionFilters, [{ kind: 'cwd', values: ['D:\\Tool\\deepseek-harness'] }])
  assert.match(formatSessionHits(result.hits), /旧对话里有 pnpm/)
})

test('cross-session search without a workspace is refused', async () => {
  const result = await runSessionSearch({
    sessionQuery: {},
    caller: { id: 'self' },
    query: 'pnpm',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /工作区/)
})

test('a targeted session outside the cwd is refused', async () => {
  const result = await runSessionSearch({
    sessionQuery: {
      async filterSessions() { return [] },
      async searchEvents() { throw new Error('must not search') },
    },
    caller: { id: 'self', cwd: 'D:\\work' },
    query: 'pnpm',
    sessionId: 'elsewhere',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /工作区/)
})

test('disabled official search is explained, not reimplemented', async () => {
  const error = new Error('search off')
  error.code = 'SESSION_QUERY_SEARCH_DISABLED'
  const result = await runSessionSearch({
    sessionQuery: { async searchSessions() { throw error } },
    caller: { id: 'self', cwd: 'D:\\work' },
    query: 'pnpm',
  })
  assert.match(result.error, /SESSION_QUERY_SEARCH_DISABLED/)
  assert.match(result.error, /first-search/)
})
