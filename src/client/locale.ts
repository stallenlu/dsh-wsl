/**
 * Locale dictionary for the client half.
 *
 * No dependency: the shipped `@deepseek-ai/dsh-client-locale` is a host-side
 * service surface, and the client registry hands this bundle no locale
 * service. `navigator.language` decides — the same signal the shell itself
 * localizes from, so zh shells read zh and everything else falls back to en.
 *
 * @module dsh-wsl/client/locale
 */

const ZH = {
  addTitle: '添加 WSL 工作区',
  distribution: '发行版',
  defaultTag: '（默认）',
  close: '关闭',
  addFolder: '添加此文件夹',
  added: '已添加 {title}',
  alreadyAdded: '{title} 已存在',
} as const

const EN = {
  addTitle: 'Add WSL workspace',
  distribution: 'Distribution',
  defaultTag: ' (default)',
  close: 'Close',
  addFolder: 'Add this folder',
  added: 'Added {title}',
  alreadyAdded: '{title} was already added',
} as const

export type Strings = typeof EN

const TABLE: Record<string, Strings> = { zh: ZH, en: EN }

/** Resolve the dictionary once per load; unknown languages fall back to en. */
export function strings(language: string | undefined = typeof navigator === 'undefined' ? undefined : navigator.language): Strings {
  const base = (language ?? 'en').toLowerCase()
  return TABLE[base] ?? TABLE[base.split('-')[0] ?? 'en'] ?? EN
}

/** `fill('{title} 已存在', 'x')` → `x 已存在`. Unknown keys stay literal. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole)
}
