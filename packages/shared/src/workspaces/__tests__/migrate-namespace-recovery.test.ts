/**
 * Migration completion marker + crash recovery tests (Issue #16 audit).
 *
 * Proves the .migrated.json commit-point semantics:
 * - partial migrations are never mistaken for completed;
 * - interrupted migrations resume on restart;
 * - explicit conflicts (unknown namespace content) are preserved;
 * - a completed migration is immune to later legacy files at the root.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureWorkspaceNamespace } from '../migrate-namespace.ts';

let ws: string;

const NS = '.craft-agent';
const MARKER = '.migrated.json';

function nsDir() {
  return join(ws, NS);
}

function markerPath() {
  return join(nsDir(), MARKER);
}

function readMarker(): { schemaVersion: number; completedAt: number; items: string[] } {
  return JSON.parse(readFileSync(markerPath(), 'utf-8'));
}

/** Write a legacy item at the workspace root (file or dir with content). */
function seedLegacy(from: string) {
  const path = join(ws, from);
  if (from.endsWith('.json') || from.endsWith('.jsonl')) {
    writeFileSync(path, `{"legacy":"${from}"}`, 'utf-8');
  } else {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'data.txt'), `legacy-${from}`, 'utf-8');
  }
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'migrate-recovery-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('ensureWorkspaceNamespace (marker + recovery)', () => {
  it('fresh workspace: namespace + critical subdirs ensured, marker written', () => {
    ensureWorkspaceNamespace(ws);

    expect(existsSync(nsDir())).toBe(true);
    for (const dir of ['sessions', 'sources', 'skills', 'statuses', 'labels']) {
      expect(existsSync(join(nsDir(), dir))).toBe(true);
    }
    const marker = readMarker();
    expect(marker.schemaVersion).toBe(1);
    expect(marker.items).toEqual([]);
  });

  it('full migration: items moved, marker lists destinations, second call is a no-op', () => {
    seedLegacy('config.json');
    seedLegacy('sessions');
    seedLegacy('sources');

    ensureWorkspaceNamespace(ws);

    // Moved into the namespace with content intact.
    expect(existsSync(join(ws, 'config.json'))).toBe(false);
    expect(readFileSync(join(nsDir(), 'workspace.json'), 'utf-8')).toContain('"config.json"');
    expect(existsSync(join(ws, 'sessions'))).toBe(false);
    expect(readFileSync(join(nsDir(), 'sessions', 'data.txt'), 'utf-8')).toBe('legacy-sessions');
    expect(existsSync(join(ws, 'sources'))).toBe(false);

    const marker = readMarker();
    expect(marker.schemaVersion).toBe(1);
    expect(marker.items.sort()).toEqual(['sessions', 'sources', 'workspace.json']);

    // Second call: marker fast path — state byte-identical (no re-moves).
    const markerBefore = readFileSync(markerPath(), 'utf-8');
    const markerMtime = statSync(markerPath()).mtimeMs;
    ensureWorkspaceNamespace(ws);
    expect(readFileSync(markerPath(), 'utf-8')).toBe(markerBefore);
    expect(statSync(markerPath()).mtimeMs).toBe(markerMtime);
    expect(readdirSync(nsDir()).sort()).toEqual(
      ['sessions', 'sources', 'skills', 'statuses', 'labels', 'workspace.json', '.migrated.json'].sort()
    );
  });

  it('interrupted migration: partial namespace + legacy remnants resume and complete', () => {
    // Previous run already moved config.json → workspace.json, then crashed.
    mkdirSync(nsDir(), { recursive: true });
    writeFileSync(join(nsDir(), 'workspace.json'), '{"partial":true}', 'utf-8');
    seedLegacy('sessions');
    seedLegacy('sources');

    ensureWorkspaceNamespace(ws);

    // Remaining legacy items were moved; the partial destination untouched.
    expect(existsSync(join(ws, 'sessions'))).toBe(false);
    expect(readFileSync(join(nsDir(), 'sessions', 'data.txt'), 'utf-8')).toBe('legacy-sessions');
    expect(existsSync(join(ws, 'sources'))).toBe(false);
    expect(readFileSync(join(nsDir(), 'workspace.json'), 'utf-8')).toBe('{"partial":true}');
    expect(readdirSync(nsDir()).sort()).toEqual(
      ['sessions', 'sources', 'skills', 'statuses', 'labels', 'workspace.json', '.migrated.json'].sort()
    );
    // Marker records only the destinations moved by this run.
    expect(readMarker().items.sort()).toEqual(['sessions', 'sources']);
  });

  it('crash after all moves but before the marker: restart validates, writes marker, zero re-moves', () => {
    // Everything already lives in the namespace (all moves done), legacy root
    // is clean, but the marker was never written.
    mkdirSync(nsDir(), { recursive: true });
    writeFileSync(join(nsDir(), 'workspace.json'), '{"migrated":true}', 'utf-8');
    mkdirSync(join(nsDir(), 'sessions'), { recursive: true });
    writeFileSync(join(nsDir(), 'sessions', 'data.txt'), 'data', 'utf-8');
    mkdirSync(join(nsDir(), 'sources'), { recursive: true });

    ensureWorkspaceNamespace(ws);

    // Marker written; data untouched; no duplicate moves (no legacy reappears).
    const marker = readMarker();
    expect(marker.schemaVersion).toBe(1);
    expect(readFileSync(join(nsDir(), 'workspace.json'), 'utf-8')).toBe('{"migrated":true}');
    expect(readFileSync(join(nsDir(), 'sessions', 'data.txt'), 'utf-8')).toBe('data');
    expect(existsSync(join(ws, 'config.json'))).toBe(false);
    expect(existsSync(join(ws, 'sessions'))).toBe(false);
  });

  it('unknown namespace content + legacy → explicit conflict, no marker, nothing touched', () => {
    seedLegacy('config.json');
    mkdirSync(nsDir(), { recursive: true });
    mkdirSync(join(nsDir(), 'unrelated-dir'), { recursive: true });
    writeFileSync(join(nsDir(), 'unrelated-dir', 'x.txt'), 'x', 'utf-8');

    const warnSpy = { called: false };
    const originalWarn = console.warn;
    console.warn = () => {
      warnSpy.called = true;
    };
    try {
      ensureWorkspaceNamespace(ws);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnSpy.called).toBe(true);
    expect(existsSync(markerPath())).toBe(false);
    // Legacy file untouched; unknown content untouched.
    expect(readFileSync(join(ws, 'config.json'), 'utf-8')).toContain('"config.json"');
    expect(readFileSync(join(nsDir(), 'unrelated-dir', 'x.txt'), 'utf-8')).toBe('x');
  });

  it('marker present + legacy file reappears at root → complete no-op', () => {
    seedLegacy('config.json');
    seedLegacy('sessions');
    ensureWorkspaceNamespace(ws);
    expect(existsSync(markerPath())).toBe(true);

    // A legacy-named file shows up after completion (e.g. user restored a file).
    seedLegacy('config.json');

    ensureWorkspaceNamespace(ws);

    // Untouched: the marker fast path never looks at the root.
    expect(readFileSync(join(ws, 'config.json'), 'utf-8')).toContain('"config.json"');
    expect(existsSync(join(nsDir(), 'workspace.json'))).toBe(true);
    expect(readMarker().items.sort()).toEqual(['sessions', 'workspace.json']);
  });
});
