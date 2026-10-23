/**
 * Background review. Every N completed turns the host may ask the current model
 * for one ADD / UPDATE / DELETE / NOOP. Parsing failures become NOOP — a bad
 * model reply must never throw into the conversation.
 *
 * A DELETE decision is a soft delete: it archives the entry (recoverable),
 * never removes it. Only the explicit memory_remove tool / HTTP DELETE may hard
 * delete.
 */

export const ACTIONS = Object.freeze(['ADD', 'UPDATE', 'DELETE', 'NOOP'])

const SYSTEM = `你是本地记忆维护员。只根据给定对话，决定要不要改用户的常驻记忆。
规则：
- 只保存稳定、以后还会用到的事实：用户偏好、环境路径、项目约定、反复踩坑。
- 不要保存密钥、token、密码、一次性问答、闲聊、已经写在 USER.md / MEMORY.md 里的内容。
- 拿不准就 NOOP。不要为了“有所作为”而写入。
- 用户画像、称呼、禁忌写入 target=user；环境与项目约定写入 target=memory；当天发生的具体事件写入 target=journal。
- action=DELETE 表示把一条记忆移入归档（archive/YYYY-MM.md），可恢复，不是永久删除。只有确定它过时或错误时才用；拿不准就 NOOP。DELETE 必须给 id 或 anchor。
- 只输出一个 JSON 对象，不要 markdown 围栏，不要解释。
字段：action (ADD|UPDATE|DELETE|NOOP), target (user|memory|journal), id (可选), anchor (可选，条目里的唯一原文片段), text (ADD/UPDATE 必填), tags (可选，逗号分隔)。DELETE 需要 id 或 anchor。`

export function createReviewScheduler({ every = 6 } = {}) {
  const n = Number(every)
  const step = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 6
  const counts = new Map()
  return {
    every: step,
    tick(sessionId) {
      const key = String(sessionId)
      const next = (counts.get(key) ?? 0) + 1
      counts.set(key, next)
      return next % step === 0
    },
    count(sessionId) {
      return counts.get(String(sessionId)) ?? 0
    },
  }
}

export function buildReviewMessages({ userText = '', memoryText = '', transcript = '' } = {}) {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        'USER.md:',
        String(userText).trim() === '' ? '（空）' : String(userText).trim(),
        '',
        'MEMORY.md:',
        String(memoryText).trim() === '' ? '（空）' : String(memoryText).trim(),
        '',
        '最近对话:',
        String(transcript).trim() === '' ? '（空）' : String(transcript).trim(),
        '',
        '只输出一个 JSON 对象。',
      ].join('\n'),
    },
  ]
}

export function extractJson(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return undefined
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return undefined
  }
}

export function parseReviewDecision(raw) {
  const value = extractJson(raw)
  if (!value || typeof value !== 'object') return { ok: true, decision: { action: 'NOOP', reason: 'unparsed' } }
  const action = String(value.action ?? '').toUpperCase()
  if (!ACTIONS.includes(action) || action === 'NOOP') return { ok: true, decision: { action: 'NOOP' } }
  const target = String(value.target ?? '')
  if (target !== 'user' && target !== 'memory' && target !== 'journal') {
    return { ok: true, decision: { action: 'NOOP', reason: 'bad_target' } }
  }
  const text = value.text === undefined ? undefined : String(value.text).trim()
  const id = value.id === undefined ? undefined : String(value.id).trim()
  const anchor = value.anchor === undefined ? undefined : String(value.anchor).trim()
  if ((action === 'ADD' || action === 'UPDATE') && !text) {
    return { ok: true, decision: { action: 'NOOP', reason: 'empty_text' } }
  }
  if ((action === 'UPDATE' || action === 'DELETE') && !id && !anchor) {
    return { ok: true, decision: { action: 'NOOP', reason: 'no_locator' } }
  }
  return {
    ok: true,
    decision: {
      action,
      target,
      ...(id ? { id } : {}),
      ...(anchor ? { anchor } : {}),
      ...(text ? { text } : {}),
      ...(value.tags !== undefined ? { tags: value.tags } : {}),
    },
  }
}

/** Apply one decision through the store. Secrets and limit errors are returned, not thrown. */
export async function applyReviewDecision(store, decision) {
  if (!decision || decision.action === 'NOOP') return { ok: true, applied: 'NOOP' }
  if (decision.action === 'ADD') return store.add({ target: decision.target, text: decision.text, tags: decision.tags })
  if (decision.action === 'UPDATE') {
    return store.replace({
      target: decision.target,
      id: decision.id,
      anchor: decision.anchor,
      text: decision.text,
      tags: decision.tags,
    })
  }
  if (decision.action === 'DELETE') {
    // DELETE is a soft delete: move the entry to archive/YYYY-MM.md. Never fall
    // back to store.remove() — an auto-review must stay recoverable.
    if (typeof store?.archive !== 'function') {
      return { ok: false, code: 'no_archive', error: '当前存储不支持可恢复归档，已拒绝 DELETE；不会回退到硬删除。' }
    }
    if (!decision.id && !decision.anchor) {
      return { ok: false, code: 'no_locator', error: 'DELETE 需要 id 或唯一原文锚点。' }
    }
    const result = await store.archive({
      ...(decision.id ? { id: decision.id } : { anchor: decision.anchor }),
      ...(decision.target ? { target: decision.target } : {}),
      reason: 'auto-review',
    })
    return result?.ok ? { ...result, applied: 'ARCHIVED' } : result
  }
  return { ok: true, applied: 'NOOP' }
}

export function transcriptFromMessages(messages, limit = 12) {
  const lines = []
  for (const message of messages ?? []) {
    const role = message?.role ?? message?.type ?? 'unknown'
    let text = ''
    if (typeof message?.content === 'string') text = message.content
    else if (Array.isArray(message?.content)) {
      text = message.content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
    } else if (typeof message?.text === 'string') text = message.text
    text = text.replace(/\s+/g, ' ').trim()
    if (text === '') continue
    lines.push(`${role}: ${text.slice(0, 500)}`)
  }
  return lines.slice(-limit).join('\n')
}
