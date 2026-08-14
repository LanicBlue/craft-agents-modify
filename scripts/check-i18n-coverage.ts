#!/usr/bin/env bun
/**
 * check-i18n-coverage.ts — CI-safe i18n key coverage check.
 *
 * Verifies every LITERAL i18n key used in source resolves against en.json:
 *   - t('key') / t("key") / i18n.t(...) / obj.t(...) — string-literal first arg
 *   - <Trans i18nKey="key" ...>
 * Dynamic keys (template literals containing ${...}, variable arguments) are
 * skipped by contract — they surface via i18next runtime missing-key warnings.
 *
 * Scans .ts/.tsx under apps/electron/src, packages/shared/src, packages/ui/src
 * and packages/core/src (when present), excluding tests, __tests__ directories,
 * locale files, node_modules and dist.
 *
 * Exits 0 with "i18n coverage OK (N literal keys)" when every literal key
 * resolves; exits 1 with a file:line key list otherwise.
 *
 * Core logic (extractLiteralKeys / findMissingKeys) is exported as pure
 * functions for direct unit testing.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Pure logic (unit-testable)
// ---------------------------------------------------------------------------

/** Match t(...) call sites where t is preceded by a non-identifier boundary. */
const T_CALL = /(^|[^A-Za-z0-9_$])t\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*?)\2/g

/** Match <Trans ... i18nKey="..."> attribute values. */
const TRANS_I18N_KEY = /<Trans\b[^>]*\bi18nKey\s*=\s*(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g

/**
 * Extract literal i18n keys from a source file's text.
 *
 * Recognizes `t('key')` / `t("key")` / `t(`key`)` (no interpolation),
 * `i18n.t(...)` and any `x.t(...)` call, plus `<Trans i18nKey="key">`.
 * Skips dynamic keys: template literals containing `${...}` and non-literal
 * first arguments (`t(someVar)` never matches because a quote must follow `(`).
 * Deliberately tolerant of keys inside comments/strings — a false positive
 * only ever fails the check, never silently passes it.
 */
export function extractLiteralKeys(source: string): string[] {
  const keys: string[] = []

  // t('key') / t("key") / t(`key`) (no interpolation) — boundary check keeps
  // longer identifiers (format(...), etc.) and bare variable args from matching.
  let match: RegExpExecArray | null
  T_CALL.lastIndex = 0
  while ((match = T_CALL.exec(source)) !== null) {
    const quote = match[2]
    const value = match[3]
    if (quote === '`' && value.includes('${')) continue // dynamic template
    keys.push(value)
  }

  TRANS_I18N_KEY.lastIndex = 0
  while ((match = TRANS_I18N_KEY.exec(source)) !== null) {
    const [raw, , value] = match
    if (raw.startsWith('`') && value.includes('${')) continue
    keys.push(value)
  }

  return keys
}

export interface CoverageIssue {
  file: string
  line: number
  key: string
}

/**
 * Build the resolution set from en.json keys, expanding plural variants:
 * call sites use the base key with {count} (convention mirrored from
 * check-i18n-parity.ts), so `key_one/_few/_many/_other` also cover `key`.
 */
export function buildEnKeySet(en: Record<string, string>): Set<string> {
  const PLURAL_SUFFIX = /_(?:zero|one|two|few|many|other)$/
  const keys = new Set<string>()
  for (const key of Object.keys(en)) {
    keys.add(key)
    if (PLURAL_SUFFIX.test(key)) keys.add(key.replace(PLURAL_SUFFIX, ''))
  }
  return keys
}

/**
 * Find literal keys that are missing from en.json, attributed to the first
 * line of the file containing each key (best-effort diagnostics).
 */
export function findMissingKeys(
  files: Array<{ file: string; source: string }>,
  enKeys: ReadonlySet<string>,
): CoverageIssue[] {
  const issues: CoverageIssue[] = []
  for (const { file, source } of files) {
    const lines = source.split('\n')
    for (const key of extractLiteralKeys(source)) {
      if (enKeys.has(key)) continue
      const lineIndex = lines.findIndex((l) => l.includes(key))
      issues.push({ file, line: lineIndex >= 0 ? lineIndex + 1 : 1, key })
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// CLI entry (runs only when invoked directly, not when imported by tests)
// ---------------------------------------------------------------------------

if (!import.meta.main) {
  // Pure functions only — tests import this module.
} else {
  const REPO_ROOT = resolve(
    import.meta.dir ?? new URL('.', import.meta.url).pathname,
    '..',
  )

  const SCAN_ROOTS = [
    'apps/electron/src',
    'packages/shared/src',
    'packages/ui/src',
    'packages/core/src',
  ]

  const IGNORED_DIRS = new Set(['node_modules', 'dist', '__tests__', 'locales'])
  const IGNORED_FILE = /\.test\.(ts|tsx)$/

  function collectSourceFiles(): Array<{ file: string; source: string }> {
    const files: Array<{ file: string; source: string }> = []
    for (const root of SCAN_ROOTS) {
      const absRoot = join(REPO_ROOT, root)
      if (!existsSync(absRoot)) continue
      const stack = [absRoot]
      while (stack.length > 0) {
        const dir = stack.pop()!
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const abs = join(dir, entry.name)
          if (entry.isDirectory()) {
            if (!IGNORED_DIRS.has(entry.name)) stack.push(abs)
          } else if (
            (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
            !IGNORED_FILE.test(entry.name)
          ) {
            const relative = abs.startsWith(REPO_ROOT) ? abs.slice(REPO_ROOT.length + 1) : abs
            files.push({ file: relative, source: readFileSync(abs, 'utf-8') })
          }
        }
      }
    }
    return files
  }

  const LOCALES_DIR = resolve(REPO_ROOT, 'packages/shared/src/i18n/locales')
  const enKeys = buildEnKeySet(
    JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf-8')) as Record<string, string>,
  )

  const files = collectSourceFiles()
  const issues = findMissingKeys(files, enKeys)
  const totalKeys = files.reduce((n, f) => n + extractLiteralKeys(f.source).length, 0)

  if (issues.length > 0) {
    for (const { file, line, key } of issues) {
      console.error(`${file}:${line}  ${key}`)
    }
    console.error(`\n${issues.length} literal i18n key(s) missing from en.json.`)
    process.exit(1)
  }

  console.log(`i18n coverage OK (${totalKeys} literal keys across ${files.length} files)`)
}
