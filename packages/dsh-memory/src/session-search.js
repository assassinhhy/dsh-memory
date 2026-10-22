/**
 * Wraps ctx.sessionQuery with the same workspace fence as the official
 * session_search tool. Does not open its own FTS index over JSONL logs.
 *
 * Fence (tool-session-query):
 * - caller must be an agent session
 * - cross-session search requires header.cwd and adds { kind: 'cwd', values: [cwd] }
 * - the caller's own session is omitted from session search
 * - a targeted session is allowed only when it is the caller or shares that cwd
 */

export function callerFromExec(exec) {
  const agent = exec?.agent
  if (!agent?.session) return undefined
  return {
    id: agent.session.id,
    cwd: agent.session.header?.cwd,
  }
}

export function formatSessionHits(hits) {
  if (!hits || hits.length === 0) return '没有在当前工作区的旧对话里找到匹配。'
  return hits.map((hit, index) => {
    const id = hit.header?.id ?? hit.sessionId ?? '?'
    const match = hit.bestMatch ?? hit
    const when = match.time ?? ''
    const snippet = String(match.snippet ?? '').replace(/\s+/g, ' ').trim()
    return `${index + 1}. session ${id}${when ? ` @ ${when}` : ''}\n${snippet}`
  }).join('\n\n')
}

export function disabledSearchMessage(error) {
  const code = error?.code ?? ''
  const message = String(error?.message ?? error ?? '')
  if (code === 'SESSION_QUERY_SEARCH_DISABLED' || message.includes('SESSION_QUERY_SEARCH_DISABLED')) {
    return '会话全文搜索未打开（SESSION_QUERY_SEARCH_DISABLED）。dsh-memory 的补丁会把 session-query-sqlite 的 openAt 设为 first-search；若 profile 的 cordis.patch.yml 在更后一层把它改回 never，请改回 first-search 后重启。'
  }
  return `会话搜索失败：${message || '未知错误'}`
}

/**
 * @param {{ sessionQuery: { searchSessions: Function, searchEvents: Function, filterSessions: Function }, caller: { id: string, cwd?: string }, query: string, sessionId?: string, limit?: number, signal?: AbortSignal }} args
 */
export async function runSessionSearch({ sessionQuery, caller, query, sessionId, limit = 8, signal }) {
  const text = String(query ?? '').trim()
  if (text === '') return { ok: false, error: 'query 不能为空' }
  if (!caller?.id) return { ok: false, error: 'session_search 需要在 Agent 会话里调用。' }
  const cap = Math.min(Math.max(Math.floor(Number(limit) || 8), 1), 20)
  try {
    if (sessionId && sessionId !== caller.id) {
      if (!caller.cwd) return { ok: false, error: '当前会话没有工作区，不能搜索其他会话（与官方工具相同）。' }
      const records = await sessionQuery.filterSessions([
        { kind: 'id', values: [sessionId] },
        { kind: 'cwd', values: [caller.cwd] },
      ], signal)
      if (!records || records.length !== 1) {
        return { ok: false, error: '目标会话不在当前工作区，已拒绝（与官方工具相同）。' }
      }
      const page = await sessionQuery.searchEvents({ sessionId, query: text, limit: cap }, { signal })
      return { ok: true, hits: page?.items ?? [] }
    }
    if (sessionId && sessionId === caller.id) {
      const page = await sessionQuery.searchEvents({ sessionId: caller.id, query: text, limit: cap }, { signal })
      return { ok: true, hits: page?.items ?? [] }
    }
    if (!caller.cwd) return { ok: false, error: '当前会话没有工作区，不能跨会话搜索（与官方工具相同）。' }
    const page = await sessionQuery.searchSessions({
      query: text,
      sessionFilters: [{ kind: 'cwd', values: [caller.cwd] }],
      limit: cap,
    }, { signal })
    const hits = (page?.items ?? []).filter((hit) => hit.header?.id !== caller.id)
    return { ok: true, hits }
  } catch (error) {
    return { ok: false, error: disabledSearchMessage(error) }
  }
}
