/**
 * Memory root is always under DSH_HOME (or ~/.dsh). This module never touches
 * AGENTS.md or .credentials.yaml — those live beside `memory/`, not inside it.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LIMITS = Object.freeze({
  user: 2000,
  memory: 4000,
})

export const TARGETS = Object.freeze(['user', 'memory', 'journal'])

/** UTF-16 code units. BMP Chinese counts as 1, matching what the files store. */
export function charLength(text) {
  return String(text ?? '').length
}

export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

export function resolveMemoryRoot(env = process.env) {
  return join(resolveDshHome(env), 'memory')
}

export function fileFor(root, target) {
  if (target === 'user') return join(root, 'USER.md')
  if (target === 'memory') return join(root, 'MEMORY.md')
  if (target === 'journal') return join(root, 'journal')
  throw new Error(`unknown memory target: ${target}`)
}

/** Calendar day in the user's zone. en-CA yields YYYY-MM-DD. */
export function zonedDay(date, timeZone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/** Calendar month in the user's zone. en-CA yields YYYY-MM when day is omitted. */
export function zonedMonth(date, timeZone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).format(date)
}

export function zonedStamp(date, timeZone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}
