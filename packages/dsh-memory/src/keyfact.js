/**
 * Stable "key fact" detection (CLAUDE_TASK_M3 B). Pure heuristics over one
 * entry's text: hostnames, ports, paths, domains/URLs, IPs and account
 * identifiers look like environment facts that are worth keeping around — so
 * after a write the runtime may *suggest* pinning the entry. Never automatic.
 *
 * Secrets are not key facts: they are refused by redact.js before anything is
 * written, and none of these patterns is meant to classify tokens. A test
 * asserts that key-looking secret assignments produce no kinds.
 */

const HOSTNAME = /\b(?:DESKTOP|LAPTOP|WIN|PC|HOST|MAC)-[A-Z0-9]{3,}\b/iu
const LOCAL_DOMAIN = /\b[a-z0-9-]+\.local\b/iu
const PORT_KEYWORD = /(?:端口|\bport\b)\s*[:=]?\s*\d{1,5}\b/iu
const PORT_BARE = /[:：]\s*\d{3,5}\b/u
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s*?"<>|]+/u
const HOME_PATH = /(?:^|[\s（("'`])~\/[^\s*?"<>|]+/u
const UNIX_PATH = /(?:^|[\s（("'`])\/(?:home|Users|usr|var|etc|opt|tmp|mnt|root|data|srv|proc|bin|lib)(?:\/[^\s*?"<>|]*)?/u
const UNC_PATH = /\\\\[^\s*?"<>|]+/u
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu
const GITHUB = /\bgithub\.com\/[A-Za-z0-9-]+/giu
const MENTION = /(?:^|[\s（("'`])@[A-Za-z0-9-]{2,}\b/u
const URL = /\bhttps?:\/\/[^\s<>"'）】]+/iu
const DOMAIN = /\b(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|dev|app|ai|edu|gov)(?:\/[^\s]*)?\b/iu
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/gu

/** Machine kind → the Chinese label used in the model-facing hint. */
export const KEY_FACT_LABELS = Object.freeze({
  hostname: '主机名',
  port: '端口',
  path: '路径',
  url: '域名/URL',
  ip: 'IP',
  account: '账号',
})

function hasIpv4(source) {
  IPV4.lastIndex = 0
  for (const match of source.matchAll(IPV4)) {
    const octets = match[0].split('.')
    if (octets.every((part) => Number(part) <= 255)) return true
  }
  return false
}

/**
 * @param {string} text one entry's text
 * @returns {{ kinds: string[] }} sorted, de-duplicated kinds (empty when plain)
 */
export function detectKeyFact(text) {
  const source = String(text ?? '')
  const kinds = new Set()
  if (URL.test(source)) kinds.add('url')
  if (hasIpv4(source)) kinds.add('ip')
  if (HOSTNAME.test(source)) kinds.add('hostname')
  if (LOCAL_DOMAIN.test(source)) kinds.add('hostname')
  if (PORT_KEYWORD.test(source) || PORT_BARE.test(source)) kinds.add('port')
  if (WINDOWS_PATH.test(source) || HOME_PATH.test(source) || UNIX_PATH.test(source) || UNC_PATH.test(source)) kinds.add('path')
  const isEmail = EMAIL.test(source)
  const isGithub = GITHUB.test(source)
  if (isEmail) kinds.add('account')
  if (isGithub) kinds.add('account')
  if (MENTION.test(source)) kinds.add('account')
  // An email / github handle is an account, not also a bare domain.
  const withoutAccounts = source.replace(EMAIL, ' ').replace(GITHUB, ' ')
  if (DOMAIN.test(withoutAccounts)) kinds.add('url')
  return { kinds: [...kinds].sort() }
}

export function keyFactLabel(kinds) {
  return (kinds ?? []).map((kind) => KEY_FACT_LABELS[kind] ?? kind).join('/')
}
