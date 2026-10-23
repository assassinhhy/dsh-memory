window.__ModuleLoader__.load({ id: "dsh-memory", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
/* dsh-memory, browser half: 设置 → 记忆.
 * Hand-written against the shared module table. scripts/build.mjs wraps this
 * in the closure-factory envelope. */
const React = require('react')
const { Button, Input } = require('@deepseek-ai/dsh-client-ui-primitives')
const h = React.createElement

const PLUGIN = 'dsh-memory'
const ENTRY = 'dsh-memory'
const NS = 'settings.dsh-memory'

const zh = {
  nav: '记忆',
  title: '记忆',
  description: 'USER.md / MEMORY.md 在会话开头冻结注入。手改文件后，下一次新会话才变。日记和向量索引不常驻。',
  usage: '字符占用',
  user: 'USER.md',
  memory: 'MEMORY.md',
  review: '自动整理',
  reviewOn: '开',
  reviewOff: '关',
  every: '每 N 轮整理一次',
  save: '保存',
  saved: '已保存，几秒内生效。',
  failed: '保存失败，请重试。',
  unavailable: '记忆插件未在当前组合中加载。',
  open: '打开记忆文件夹',
  reindex: '重建索引',
  reindexed: '索引已重建。',
  refresh: '刷新',
  delete: '删除（不可恢复）',
  edit: '编辑',
  saveEntry: '保存条目',
  deleted: '已删除（不可恢复）。',
  empty: '没有条目。',
  embed: '向量模型',
  loading: '读取中…',
  lastUsed: '最后使用',
  never: '从未',
  uses: '使用',
  times: '次',
  decayScore: '衰减分',
  pin: '📌 置顶',
  unpin: '取消置顶',
  pinOn: '已置顶。',
  pinOff: '已取消置顶。',
  archive: '归档（可恢复）',
  archived: '已归档，可以在归档区恢复。',
  restore: '恢复',
  restored: '已恢复。',
  archiveTitle: '归档',
  archiveEmpty: '归档是空的。归档不是删除，可以随时恢复。',
  from: '原位置',
  suggestions: '整理建议',
  suggestionsHint: '每周自动整理一次，只出建议，永不自动执行。置顶条目不会出现在「过时」里。',
  noSuggestions: '暂无待处理的建议。',
  accept: '同意',
  reject: '拒绝',
  editAccept: '编辑后同意',
  cancel: '取消',
  rejectAll: '一键全部拒绝',
  accepted: '已同意并执行。',
  rejected: '已拒绝。',
  allRejected: '已全部拒绝。',
  runNow: '立即整理',
  runNowDone: '整理完成。',
  runNowFailed: '整理失败，请重试。',
  lastConsolidation: '上次整理',
  nextConsolidation: '下次整理',
  dueNow: '已到期',
  typeMerge: '合并',
  typeStale: '过时（建议归档）',
  typePromote: '晋升（只建议）',
  typeConflict: '冲突',
  reason: '理由',
  proposed: '建议文本',
  ids: '条目',
  droppedPinned: '已剔除置顶',
  decayParams: '衰减参数（只影响检索排序，不删东西）',
  halfLifeUser: 'USER 半衰期（天）',
  halfLifeMemory: 'MEMORY 半衰期（天）',
  halfLifeJournal: '日记半衰期（天）',
  useBoost: '使用加成',
}
const en = {
  nav: 'Memory',
  title: 'Memory',
  description: 'USER.md and MEMORY.md are frozen into the prompt at session start. Hand edits apply on the next new session.',
  usage: 'Characters',
  user: 'USER.md',
  memory: 'MEMORY.md',
  review: 'Auto review',
  reviewOn: 'On',
  reviewOff: 'Off',
  every: 'Review every N turns',
  save: 'Save',
  saved: 'Saved.',
  failed: 'Saving failed.',
  unavailable: 'The memory plugin is not loaded in this composition.',
  open: 'Open memory folder',
  reindex: 'Rebuild index',
  reindexed: 'Index rebuilt.',
  refresh: 'Refresh',
  delete: 'Delete (permanent)',
  edit: 'Edit',
  saveEntry: 'Save entry',
  deleted: 'Deleted (permanent).',
  empty: 'No entries.',
  embed: 'Embedding model',
  loading: 'Loading…',
  lastUsed: 'Last used',
  never: 'never',
  uses: 'used',
  times: '×',
  decayScore: 'Decay score',
  pin: '📌 Pin',
  unpin: 'Unpin',
  pinOn: 'Pinned.',
  pinOff: 'Unpinned.',
  archive: 'Archive (recoverable)',
  archived: 'Archived — restorable below.',
  restore: 'Restore',
  restored: 'Restored.',
  archiveTitle: 'Archive',
  archiveEmpty: 'Archive is empty. Archiving is not deletion — entries can be restored.',
  from: 'from',
  suggestions: 'Consolidation suggestions',
  suggestionsHint: 'Produced weekly. Suggestions only — nothing is ever applied automatically. Pinned entries never appear as stale.',
  noSuggestions: 'No pending suggestions.',
  accept: 'Accept',
  reject: 'Reject',
  editAccept: 'Edit & accept',
  cancel: 'Cancel',
  rejectAll: 'Reject all',
  accepted: 'Accepted and applied.',
  rejected: 'Rejected.',
  allRejected: 'All rejected.',
  runNow: 'Consolidate now',
  runNowDone: 'Consolidation done.',
  runNowFailed: 'Consolidation failed.',
  lastConsolidation: 'Last',
  nextConsolidation: 'Next',
  dueNow: 'due',
  typeMerge: 'Merge',
  typeStale: 'Stale (archive)',
  typePromote: 'Promote (suggest only)',
  typeConflict: 'Conflict',
  reason: 'Reason',
  proposed: 'Proposed text',
  ids: 'ids',
  droppedPinned: 'pinned dropped',
  decayParams: 'Decay parameters (rank only — nothing is deleted)',
  halfLifeUser: 'USER half-life (days)',
  halfLifeMemory: 'MEMORY half-life (days)',
  halfLifeJournal: 'Journal half-life (days)',
  useBoost: 'Use boost',
}

const CSS = `
.dsh-mem{padding:8px 0 24px;color:var(--dsw-alias-label-primary)}
.dsh-mem-title{font-size:16px;line-height:24px}
.dsh-mem-desc,.dsh-mem-meta{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-mem-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsh-mem-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.dsh-mem-entry{padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsh-mem-id{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsh-mem-text{margin:4px 0;white-space:pre-wrap;font-size:13px;line-height:20px}
.dsh-mem-status{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsh-mem-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.dsh-mem-section{margin-top:20px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dsh-mem-cols{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:4px 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsh-mem-sug{padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsh-mem-badge{display:inline-block;padding:1px 6px;border-radius:8px;background:var(--dsw-alias-fill-l2);font-size:11px}
.dsh-mem-sug[data-status=accepted] .dsh-mem-text{opacity:.6}
.dsh-mem-sug[data-status=rejected] .dsh-mem-text{opacity:.4;text-decoration:line-through}
`

const TYPE_KEYS = { merge: 'typeMerge', stale: 'typeStale', promote: 'typePromote', conflict: 'typeConflict' }
const TYPE_ORDER = ['merge', 'stale', 'promote', 'conflict']

function dayOf(ms) {
  const time = Number(ms)
  if (!Number.isFinite(time) || time <= 0) return null
  return new Date(time).toISOString().slice(0, 10)
}

function MemoryPage({ t, form, close }) {
  const snapshot = React.useSyncExternalStore(form.subscribe.bind(form), form.getSnapshot.bind(form))
  const value = snapshot.value ?? {}
  const disabled = snapshot.status !== 'ready' || snapshot.writable === false
  const [state, setState] = React.useState(undefined)
  const [status, setStatus] = React.useState(undefined)
  const [editing, setEditing] = React.useState(undefined)
  const [draft, setDraft] = React.useState('')
  const [every, setEvery] = React.useState(String(value.reviewEvery ?? 6))
  const [editingSug, setEditingSug] = React.useState(undefined)
  const [sugDraft, setSugDraft] = React.useState('')
  const [decay, setDecay] = React.useState(undefined)
  React.useEffect(() => { setEvery(String(value.reviewEvery ?? 6)) }, [value.reviewEvery])
  React.useEffect(() => {
    if (!state?.decay) return
    setDecay({
      halfLifeUser: String(state.decay.halfLifeUser ?? 60),
      halfLifeMemory: String(state.decay.halfLifeMemory ?? 60),
      halfLifeJournal: String(state.decay.halfLifeJournal ?? 21),
      useBoost: String(state.decay.useBoost ?? 0.25),
    })
  }, [state?.decay])

  const load = React.useCallback(() => {
    fetch('/dsh-memory/state', { cache: 'no-store', credentials: 'same-origin' })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(String(res.status))))
      .then(setState)
      .catch(() => setStatus({ tone: 'error', text: t('failed') }))
  }, [t])
  React.useEffect(() => { load() }, [load])

  const write = (ops, okText) => {
    setStatus(undefined)
    form.mutate(ops).then((ok) => setStatus(ok ? { tone: 'ok', text: okText } : { tone: 'error', text: t('failed') }),
      () => setStatus({ tone: 'error', text: t('failed') }))
  }
  const post = (path, body, okText) => {
    const init = body === undefined
      ? { method: 'POST', credentials: 'same-origin' }
      : {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    return fetch(path, init)
      .then((res) => res.ok ? res.json() : res.json().then((err) => Promise.reject(new Error(err.error || String(res.status)))))
      .then((result) => {
        if (result && result.ok === false) { setStatus({ tone: 'error', text: result.error || t('failed') }); return result }
        setStatus({ tone: 'ok', text: okText })
        load()
        return result
      })
      .catch((error) => setStatus({ tone: 'error', text: error?.message || t('failed') }))
  }
  const saveEntry = (id) => {
    fetch('/dsh-memory/entry', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, text: draft }),
    }).then((res) => res.json())
      .then((body) => {
        if (body.ok === false) { setStatus({ tone: 'error', text: body.error || t('failed') }); return }
        setEditing(undefined)
        setStatus({ tone: 'ok', text: t('saved') })
        load()
      })
      .catch(() => setStatus({ tone: 'error', text: t('failed') }))
  }
  const remove = (id) => {
    fetch('/dsh-memory/entry', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }).then((res) => res.ok ? res.json() : Promise.reject(new Error(String(res.status))))
      .then((body) => {
        if (body.ok === false) { setStatus({ tone: 'error', text: body.error || t('failed') }); return }
        setStatus({ tone: 'ok', text: t('deleted') })
        load()
      })
      .catch(() => setStatus({ tone: 'error', text: t('failed') }))
  }
  const decide = (sug, action) => {
    const body = { week: sug.week, key: sug.key, action }
    if (action === 'accept' && editingSug === sug.key) body.text = sugDraft
    post('/dsh-memory/suggestion', body, action === 'accept' ? t('accepted') : t('rejected'))
      .then(() => {
        if (action === 'accept' || editingSug === sug.key) {
          setEditingSug(undefined)
          setSugDraft('')
        }
      })
  }
  const saveDecay = () => {
    const next = Number(decay.halfLifeUser)
    const nextMem = Number(decay.halfLifeMemory)
    const nextJour = Number(decay.halfLifeJournal)
    const nextBoost = Number(decay.useBoost)
    if (!Number.isFinite(next) || next < 1 || !Number.isFinite(nextMem) || nextMem < 1
      || !Number.isFinite(nextJour) || nextJour < 1 || !Number.isFinite(nextBoost) || nextBoost < 0) {
      setStatus({ tone: 'error', text: t('failed') })
      return
    }
    write([
      { op: 'set', path: ['halfLifeUser'], value: Math.round(next) },
      { op: 'set', path: ['halfLifeMemory'], value: Math.round(nextMem) },
      { op: 'set', path: ['halfLifeJournal'], value: Math.round(nextJour) },
      { op: 'set', path: ['useBoost'], value: nextBoost },
    ], t('saved'))
  }

  const fileBlock = (label, file) => h('div', { className: 'dsh-mem-row' },
    h('div', null,
      h('div', null, label),
      h('div', { className: 'dsh-mem-meta' }, file ? `${file.used}/${file.limit}` : t('loading'))),
    file && h('div', { className: 'dsh-mem-meta' }, `${Math.min(100, Math.round((file.used / file.limit) * 100))}%`))

  const entries = state?.entries ?? [
    ...(state?.user?.entries ?? []).map((entry) => ({ ...entry, file: 'user' })),
    ...(state?.memory?.entries ?? []).map((entry) => ({ ...entry, file: 'memory' })),
  ]
  const suggestions = state?.consolidation?.suggestions ?? []
  const pending = suggestions.filter((sug) => sug.status === 'pending')
  const archived = state?.archive ?? []
  const cons = state?.consolidation ?? {}
  const fmtWhen = (ms) => (ms == null ? t('never') : (dayOf(ms) || t('never')))

  return h('div', { className: 'dsh-mem', 'data-dsh-memory': '' },
    h('div', { className: 'dsh-mem-title' }, t('title')),
    h('div', { className: 'dsh-mem-desc' }, t('description')),
    snapshot.status === 'unavailable' && h('div', { className: 'dsh-mem-status', 'data-tone': 'error', role: 'alert' }, t('unavailable')),
    h('div', { className: 'dsh-mem-meta', style: { marginTop: 12 } }, t('usage')),
    fileBlock(t('user'), state?.user),
    fileBlock(t('memory'), state?.memory),
    h('div', { className: 'dsh-mem-row' },
      h('div', null, t('review')),
      h(Button, {
        size: 'sm',
        disabled,
        onClick: () => write([{ op: 'set', path: ['autoReview'], value: value.autoReview === false }], t('saved')),
      }, value.autoReview === false ? t('reviewOff') : t('reviewOn'))),
    h('div', { className: 'dsh-mem-row' },
      h('label', { className: 'dsh-mem-meta' }, t('every')),
      h('div', { style: { display: 'flex', gap: 8 } },
        h(Input, {
          value: every,
          disabled,
          style: { width: 72 },
          onChange: (event) => setEvery(event.target.value),
        }),
        h(Button, {
          size: 'sm',
          disabled,
          onClick: () => {
            const next = Number(every)
            if (!Number.isInteger(next) || next < 1 || next > 100) { setStatus({ tone: 'error', text: t('failed') }); return }
            write([{ op: 'set', path: ['reviewEvery'], value: next }], t('saved'))
          },
        }, t('save')))),
    h('div', { className: 'dsh-mem-meta' }, `${t('embed')}：${state?.embed?.state ?? t('loading')}${state?.embed?.error ? ` (${state.embed.error})` : ''}`),
    h('div', { className: 'dsh-mem-actions' },
      h(Button, { size: 'sm', onClick: () => post('/dsh-memory/open', undefined, state?.root ?? t('open')) }, t('open')),
      h(Button, { size: 'sm', onClick: () => post('/dsh-memory/reindex', undefined, t('reindexed')) }, t('reindex')),
      h(Button, { size: 'sm', onClick: load }, t('refresh')),
      close && h(Button, { size: 'sm', onClick: close }, '关闭')),

    h('div', { className: 'dsh-mem-section' },
      h('div', { className: 'dsh-mem-meta' }, t('decayParams')),
      decay && h('div', { className: 'dsh-mem-cols' },
        ['halfLifeUser', 'halfLifeMemory', 'halfLifeJournal', 'useBoost'].map((key) =>
          h('label', { key, style: { display: 'flex', gap: 6, alignItems: 'center' } },
            t(key),
            h(Input, {
              value: decay[key],
              disabled,
              style: { width: 64 },
              onChange: (event) => setDecay({ ...decay, [key]: event.target.value }),
            }))),
        h(Button, { size: 'sm', disabled, onClick: saveDecay }, t('save')))),

    entries.length === 0 && h('div', { className: 'dsh-mem-meta' }, t('empty')),
    entries.map((entry) => h('div', { className: 'dsh-mem-entry', key: `${entry.file}:${entry.id}` },
      h('div', { className: 'dsh-mem-id' }, `${entry.file} · ${entry.id} · ${entry.chars}`),
      h('div', { className: 'dsh-mem-text' }, editing === entry.id
        ? h('textarea', {
          value: draft,
          rows: 4,
          style: { width: '100%' },
          onChange: (event) => setDraft(event.target.value),
        })
        : entry.text),
      h('div', { className: 'dsh-mem-cols' },
        h('span', null, `${t('lastUsed')}：${entry.lastUsedAt == null ? t('never') : (dayOf(entry.lastUsedAt) || t('never'))}`),
        h('span', null, `${t('uses')} ${entry.useCount ?? 0} ${t('times')}`),
        h('span', null, `${t('decayScore')} ${Number(entry.decayScore ?? 0).toFixed(3)}`),
        entry.pinned && h('span', { className: 'dsh-mem-badge' }, '📌')),
      h('div', { className: 'dsh-mem-actions' },
        editing === entry.id
          ? h(Button, { size: 'sm', onClick: () => saveEntry(entry.id) }, t('saveEntry'))
          : h(Button, { size: 'sm', onClick: () => { setEditing(entry.id); setDraft(entry.text) } }, t('edit')),
        h(Button, {
          size: 'sm',
          onClick: () => post('/dsh-memory/pin', { id: entry.id, pinned: entry.pinned !== true }, entry.pinned !== true ? t('pinOn') : t('pinOff')),
        }, entry.pinned ? t('unpin') : t('pin')),
        entry.id !== 'unfenced' && h(Button, {
          size: 'sm',
          onClick: () => post('/dsh-memory/archive', { id: entry.id }, t('archived')),
        }, t('archive')),
        entry.id !== 'unfenced' && h(Button, { size: 'sm', onClick: () => remove(entry.id) }, t('delete'))))),

    h('div', { className: 'dsh-mem-section' },
      h('div', { className: 'dsh-mem-title' }, t('suggestions')),
      h('div', { className: 'dsh-mem-desc' }, t('suggestionsHint')),
      h('div', { className: 'dsh-mem-cols' },
        h('span', null, `${t('lastConsolidation')}：${fmtWhen(cons.lastAt)}`),
        h('span', null, `${t('nextConsolidation')}：${cons.due ? t('dueNow') : fmtWhen(cons.nextAt)}`),
        h(Button, { size: 'sm', onClick: () => post('/dsh-memory/consolidate', undefined, t('runNowDone')) }, t('runNow')),
        pending.length > 0 && h(Button, {
          size: 'sm',
          onClick: () => post('/dsh-memory/suggestions/reject-all', {}, t('allRejected')),
        }, t('rejectAll'))),
      pending.length === 0 && suggestions.length === 0 && h('div', { className: 'dsh-mem-meta' }, t('noSuggestions')),
      TYPE_ORDER.map((type) => {
        const items = suggestions.filter((sug) => sug.type === type)
        if (items.length === 0) return null
        return h('div', { key: type },
          h('div', { className: 'dsh-mem-meta' }, t(TYPE_KEYS[type])),
          items.map((sug) => h('div', {
            key: `${sug.week}:${sug.key}`,
            className: 'dsh-mem-sug',
            'data-status': sug.status,
          },
            h('div', { className: 'dsh-mem-id' }, `${sug.key} · ${sug.status} · ${t('ids')}: ${sug.ids.join(', ')}`),
            sug.reason && h('div', { className: 'dsh-mem-meta' }, `${t('reason')}：${sug.reason}`),
            (sug.text || editingSug === sug.key) && h('div', { className: 'dsh-mem-text' },
              editingSug === sug.key
                ? h('textarea', {
                  value: sugDraft,
                  rows: 3,
                  style: { width: '100%' },
                  onChange: (event) => setSugDraft(event.target.value),
                })
                : `${t('proposed')}：${sug.text}`),
            sug.droppedIds?.length > 0 && h('div', { className: 'dsh-mem-meta' }, `${t('droppedPinned')}：${sug.droppedIds.join(', ')}`),
            sug.status === 'pending' && h('div', { className: 'dsh-mem-actions' },
              h(Button, { size: 'sm', onClick: () => decide(sug, 'accept') }, t('accept')),
              sug.type !== 'stale' && (editingSug === sug.key
                ? h(Button, { size: 'sm', onClick: () => { setEditingSug(undefined); setSugDraft('') } }, t('cancel'))
                : h(Button, {
                  size: 'sm',
                  onClick: () => { setEditingSug(sug.key); setSugDraft(sug.text ?? '') },
                }, t('editAccept'))),
              h(Button, { size: 'sm', onClick: () => decide(sug, 'reject') }, t('reject')),
            ),
          )),
        )
      }),
    ),

    h('div', { className: 'dsh-mem-section' },
      h('div', { className: 'dsh-mem-title' }, t('archiveTitle')),
      h('div', { className: 'dsh-mem-desc' }, t('archiveEmpty')),
      archived.map((record) => h('div', { className: 'dsh-mem-entry', key: `arch:${record.id}` },
        h('div', { className: 'dsh-mem-id' }, `${record.file} · ${record.id} · ${t('from')}: ${record.from}${record.at ? ` · ${record.at}` : ''}`),
        h('div', { className: 'dsh-mem-text' }, record.text),
        h('div', { className: 'dsh-mem-actions' },
          h(Button, {
            size: 'sm',
            onClick: () => post('/dsh-memory/restore', { id: record.id }, t('restored')),
          }, t('restore')))))),
    status && h('div', { className: 'dsh-mem-status', 'data-tone': status.tone, role: status.tone === 'error' ? 'alert' : 'status' }, status.text))
}

exports.name = PLUGIN
exports.inject = ['slots', 'locale', 'configForms']
exports.apply = function apply(ctx) {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'dsh-memory: styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory: dictionaries')
  const form = ctx.configForms.get(ENTRY)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'memory',
    order: 40,
    label: '记忆',
    locale: NS,
    inject: () => ({ form }),
  }, MemoryPage))
}

return module.exports; } });
