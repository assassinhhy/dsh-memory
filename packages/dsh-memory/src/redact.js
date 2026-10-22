/**
 * Refuse writes that look like secrets. The error lists detector kinds only —
 * never the matched text — so a tool result cannot echo a key into the transcript.
 *
 * Policy is refuse, not redact-and-store: a redacted shell ("password=[REDACTED]")
 * still teaches the model that a secret was offered, and looks like a successful save.
 */

const PLACEHOLDERS = new Set([
  '***',
  '****',
  'xxxxx',
  'xxx',
  'todo',
  'changeme',
  'redacted',
  '[redacted]',
  '<secret>',
  '<token>',
  'your_api_key',
  'your-api-key',
  'example',
  'placeholder',
])

const DETECTORS = [
  {
    kind: 'private_key',
    re: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/,
  },
  {
    kind: 'aws_access_key',
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    kind: 'github_token',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  },
  {
    kind: 'api_key',
    re: /\bsk-[A-Za-z0-9_-]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z\-_]{20,}\b/,
  },
  {
    kind: 'bearer',
    re: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}={0,2}\b/,
  },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/,
  },
]

const ASSIGNMENT = /(?:^|[\s;,(])((?:[A-Za-z0-9_]*_)?(?:api[_-]?key|secret|password|passwd|token|access[_-]?key|credential)s?)\s*[:=]\s*(['"]?)(\S+)\2/gi

function cleanAssigned(value) {
  return value.replace(/[,;]+$/g, '').replace(/^['"]|['"]$/g, '')
}

function isPlaceholder(value) {
  const trimmed = cleanAssigned(value).trim()
  if (PLACEHOLDERS.has(trimmed.toLowerCase())) return true
  if (/^[*xX.<>-]+$/.test(trimmed)) return true
  return false
}

/**
 * @returns {{ ok: true } | { ok: false, kinds: string[] }}
 */
export function scanSecrets(text) {
  const source = String(text ?? '')
  const kinds = new Set()
  for (const detector of DETECTORS) {
    detector.re.lastIndex = 0
    if (detector.re.test(source)) kinds.add(detector.kind)
  }
  ASSIGNMENT.lastIndex = 0
  for (const match of source.matchAll(ASSIGNMENT)) {
    const value = cleanAssigned(match[3] ?? '')
    if (value.length < 4) continue
    if (isPlaceholder(value)) continue
    const keyword = String(match[1] ?? '').toLowerCase()
    const strict = /password|passwd|secret|api[_-]?key|credential/.test(keyword)
    if (!strict && /[^\x00-\x7F]/.test(value) && !/^[A-Za-z0-9+/_=-]{16,}$/.test(value)) continue
    kinds.add('credential_assignment')
  }
  if (kinds.size === 0) return { ok: true }
  return { ok: false, kinds: [...kinds] }
}

export function secretError(kinds) {
  const list = kinds.length > 0 ? kinds.join(', ') : 'secret'
  return `拒绝写入：检测到疑似密钥（${list}）。记忆文件不能保存密钥、token 或密码。请去掉敏感片段后再试。`
}
