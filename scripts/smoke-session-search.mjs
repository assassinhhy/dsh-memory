/**
 * Real session_search smoke (acceptance, 2026-10-22).
 *
 * Opens the official session-query stack over C:\Users\Gabi\.dsh\sessions the
 * same way the plugin does at runtime — Cordis Context + SessionStore +
 * SessionProjectionRegistry + JsonlSessionPersistence + SqliteSessionQueryEngine
 * with openAt: first-search and the derived index at
 * DSH_HOME/memory/session-index.sqlite (the path in cordis.patch.yml) — then
 * runs the plugin's own runSessionSearch wrapper over it.
 *
 * Reads only: session logs are opened through read handles; the derived index
 * is the only write target (it is a disposable search index by design).
 * Snippets are secret-screened (src/redact.js) and withheld on any hit.
 */
import { createRequire } from 'node:module'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveDshHome } from '../packages/dsh-memory/src/paths.js'
import { scanSecrets } from '../packages/dsh-memory/src/redact.js'
import { runSessionSearch } from '../packages/dsh-memory/src/session-search.js'

const harnessRoot = new URL('../../', import.meta.url)
const sqliteLib = new URL('packages/session-query/session-query-sqlite/lib/index.js', harnessRoot)
const requireFromSqlite = createRequire(sqliteLib)

const dshHome = resolveDshHome()
const sessionsRoot = join(dshHome, 'sessions')
const indexPath = join(dshHome, 'memory', 'session-index.sqlite')

function log(line) {
  console.log(line)
}

function safeSnippet(text) {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim()
  const scanned = scanSecrets(source)
  if (!scanned.ok) return `[snippet withheld: possible secret kinds=${scanned.kinds.join(',')}]`
  return source.slice(0, 160)
}

async function statOf(path) {
  try {
    const st = await stat(path)
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size }
  } catch (error) {
    return { exists: false, error: String(error?.code ?? error?.message ?? error) }
  }
}

function indexRows(path) {
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
  try {
    const sessions = db.prepare('SELECT COUNT(*) AS n FROM persisted_sessions').get().n
    const docs = db.prepare('SELECT COUNT(*) AS n FROM persisted_docs').get().n
    return { persisted_sessions: sessions, persisted_docs: docs }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  } finally {
    db.close()
  }
}

async function listSessionLogs() {
  const { readdir } = await import('node:fs/promises')
  const found = []
  async function walk(dir, depth) {
    if (depth > 4) return
    let names
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      const st = await stat(full).catch(() => undefined)
      if (!st) continue
      if (st.isDirectory()) await walk(full, depth + 1)
      else found.push({ path: full, mtimeMs: st.mtimeMs, size: st.size })
    }
  }
  await walk(sessionsRoot, 0)
  return found
}

const before = {
  index: await statOf(indexPath),
  rows: indexRows(indexPath),
  logs: await listSessionLogs(),
}
log(`BEFORE ${JSON.stringify({ index: before.index, rows: before.rows, logCount: before.logs.length })}`)

const ctx = new (requireFromSqlite('@deepseek-ai/cordis').Context)()
const sessionNs = requireFromSqlite('@deepseek-ai/dsh-session')
const SessionStore = sessionNs.default ?? sessionNs.SessionStore
const projectionNs = requireFromSqlite('@deepseek-ai/dsh-session-projection')
const SessionProjectionRegistry = projectionNs.default ?? projectionNs.SessionProjectionRegistry
const JsonlSessionPersistence = requireFromSqlite('@deepseek-ai/dsh-session-persistence-jsonl')
const queryModule = await import(sqliteLib.href)
const SqliteSessionQueryEngine = queryModule.default ?? queryModule.SqliteSessionQueryEngine

await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SessionStore)
const persistence = await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot })
const engine = await ctx.plugin(SqliteSessionQueryEngine, {
  path: indexPath,
  openAt: 'first-search',
})
log(`ENGINE openAt=first-search path=${indexPath}`)

const listed = await ctx.sessionQuery.listSessions()
log(`SESSIONS ${JSON.stringify(listed.map((row) => ({ id: row.header?.id, cwd: row.header?.cwd, persisted: row.persisted, live: row.live })))}`)

const cwds = [...new Set(listed.map((row) => row.header?.cwd).filter(Boolean))]
if (cwds.length === 0) {
  log('RESULT {"ok":false,"reason":"no sessions discovered under the official sessions root"}')
  await engine.close?.()
  process.exitCode = 1
} else {
  const queries = ['dsh', 'memory', '记忆', '测试', 'package', 'pnpm', 'session', '搜索']
  const reports = []
  for (const cwd of cwds) {
    for (const query of queries) {
      const result = await runSessionSearch({
        sessionQuery: ctx.sessionQuery,
        caller: { id: 'verify-smoke-2026-10-22', cwd },
        query,
        limit: 5,
      })
      if (!result.ok) {
        reports.push({ cwd, query, ok: false, error: result.error })
        continue
      }
      reports.push({
        cwd,
        query,
        ok: true,
        hits: result.hits.map((hit) => ({
          session: hit.header?.id ?? hit.sessionId ?? '?',
          time: hit.bestMatch?.time ?? '',
          snippet: safeSnippet(hit.bestMatch?.snippet ?? hit.snippet ?? ''),
        })),
      })
    }
  }

  for (const report of reports) {
    if (!report.ok) {
      log(`QUERY cwd=${report.cwd} q=${report.query} ERROR ${report.error}`)
      continue
    }
    log(`QUERY cwd=${report.cwd} q=${report.query} hits=${report.hits.length}`)
    for (const hit of report.hits) log(`  - ${hit.session} ${hit.time} :: ${hit.snippet}`)
  }

  const after = {
    index: await statOf(indexPath),
    wal: await statOf(`${indexPath}-wal`),
    rows: indexRows(indexPath),
    logs: await listSessionLogs(),
  }
  const logsTouched = after.logs.filter((file) => {
    const beforeFile = before.logs.find((other) => other.path === file.path)
    return !beforeFile || beforeFile.mtimeMs !== file.mtimeMs || beforeFile.size !== file.size
  })
  log(`AFTER ${JSON.stringify({ index: after.index, rows: after.rows, logCount: after.logs.length, logsTouched: logsTouched.map((f) => f.path) })}`)

  const searched = reports.filter((report) => report.ok).length
  const hitQueries = reports.filter((report) => report.ok && report.hits.length > 0).map((report) => report.query)
  const rowsOk = Number(after.rows?.persisted_docs ?? 0) > 0 && Number(after.rows?.persisted_sessions ?? 0) > 0
  // WAL journal: row growth is the real "index updated" signal; the main file's
  // mtime/size only moves on checkpoint.
  const rowsGrew = Number(after.rows?.persisted_docs ?? 0) > Number(before.rows?.persisted_docs ?? 0)
    || Number(after.rows?.persisted_sessions ?? 0) > Number(before.rows?.persisted_sessions ?? 0)
  const indexUpdated = after.index.exists && (
    !before.index.exists
    || rowsGrew
    || before.index.mtimeMs !== after.index.mtimeMs
    || before.index.size !== after.index.size
  )
  const ok = searched > 0 && rowsOk && logsTouched.length === 0
  log(`RESULT ${JSON.stringify({
    ok,
    searchedQueries: searched,
    hitQueries,
    indexCreatedOrUpdated: indexUpdated,
    rowsGrew,
    rowsBefore: before.rows,
    rowsAfter: after.rows,
    indexAfter: after.index,
    walAfter: after.wal,
    sessionLogsWritten: logsTouched.map((f) => f.path),
  })}`)
  try {
    await engine.close?.()
    await persistence.dispose?.()
  } catch (error) {
    log(`CLEANUP ${String(error?.message ?? error)}`)
  }
  if (!ok) process.exitCode = 1
}
