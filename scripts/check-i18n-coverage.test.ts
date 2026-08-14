/**
 * Tests for scripts/check-i18n-coverage.ts — pure extraction/validation logic.
 */

import { describe, it, expect } from 'bun:test';
import { extractLiteralKeys, findMissingKeys, buildEnKeySet } from './check-i18n-coverage.ts';

describe('extractLiteralKeys', () => {
  it('extracts single-quoted t() keys', () => {
    expect(extractLiteralKeys(`t('common.cancel')`)).toEqual(['common.cancel']);
  });

  it('extracts double-quoted t() keys', () => {
    expect(extractLiteralKeys(`t("common.save")`)).toEqual(['common.save']);
  });

  it('extracts non-interpolated template literal keys', () => {
    expect(extractLiteralKeys('t(`common.retry`)')).toEqual(['common.retry']);
  });

  it('skips interpolated template literal keys (dynamic)', () => {
    expect(extractLiteralKeys('t(`status.${id}`)')).toEqual([]);
  });

  it('skips non-literal (variable) arguments', () => {
    expect(extractLiteralKeys('t(someKey)')).toEqual([]);
    expect(extractLiteralKeys('t(getKey())')).toEqual([]);
  });

  it('extracts i18n.t(...) and object-property t(...) calls', () => {
    expect(extractLiteralKeys(`i18n.t('a.b')`)).toEqual(['a.b']);
    expect(extractLiteralKeys(`props.t('c.d')`)).toEqual(['c.d']);
  });

  it('does not match identifiers ending in t (format(...))', () => {
    expect(extractLiteralKeys(`format('a.b')`)).toEqual([]);
  });

  it('handles whitespace after the opening paren', () => {
    expect(extractLiteralKeys(`t( 'a.b' )`)).toEqual(['a.b']);
  });

  it('extracts <Trans i18nKey="..."> attributes', () => {
    expect(extractLiteralKeys(`<Trans i18nKey="x.y">text</Trans>`)).toEqual(['x.y']);
    expect(extractLiteralKeys(`<Trans i18nKey='p.q' />`)).toEqual(['p.q']);
  });

  it('extracts multiple keys from one source', () => {
    const source = `t('a') + t('b') + <Trans i18nKey="c" />`;
    expect(extractLiteralKeys(source).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('findMissingKeys', () => {
  const enKeys = new Set(['a.b', 'c.d']);

  it('reports keys missing from en.json with file + line attribution', () => {
    const issues = findMissingKeys(
      [
        { file: 'src/x.ts', source: `t('a.b')\nt('nope')` },
        { file: 'src/y.tsx', source: `t('c.d')\n<Trans i18nKey="gone" />` },
      ],
      enKeys,
    );
    expect(issues).toEqual([
      { file: 'src/x.ts', line: 2, key: 'nope' },
      { file: 'src/y.tsx', line: 2, key: 'gone' },
    ]);
  });

  it('treats plural variants as covered (call sites use the base key)', () => {
    // en.json stores count_one/count_other; the call site uses the base key.
    const pluralKeys = buildEnKeySet({ 'count_one': '1', 'count_other': '{{count}}' });
    expect(pluralKeys.has('count')).toBe(true);
    const issues = findMissingKeys(
      [{ file: 'src/x.ts', source: `t('count', { count: 3 })` }],
      pluralKeys,
    );
    expect(issues).toEqual([]);
  });

  it('returns no issues when every key resolves', () => {
    const issues = findMissingKeys(
      [{ file: 'src/x.ts', source: `t('a.b')\nt('c.d')` }],
      enKeys,
    );
    expect(issues).toEqual([]);
  });

  it('handles empty sources', () => {
    expect(findMissingKeys([{ file: 'src/empty.ts', source: '' }], enKeys)).toEqual([]);
  });
});
