/**
 * Workspace Namespace Migration
 *
 * One-time, idempotent migration of legacy workspace-local metadata from the
 * workspace root into the .craft-agent/ namespace directory.
 *
 * Triggered from loadWorkspaceConfig()/loadWorkspace() (covers all production
 * read paths) and is a fast no-op for already-migrated or fresh workspaces.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  renameSync,
  cpSync,
  rmSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
// NOTE: circular import with ./storage.ts is safe — WORKSPACE_NAMESPACE is only
// accessed inside function bodies, never at module initialization time.
import { WORKSPACE_NAMESPACE } from './storage.ts';
import { atomicWriteFileSync } from '../utils/files.ts';
import { debug } from '../utils/debug.ts';

// Legacy root-level items migrated into .craft-agent/ (in order).
// config.json is first so workspace.json lands in the namespace before anything
// else reads through loadWorkspaceConfig().
const MIGRATION_ITEMS: Array<{ from: string; to: string }> = [
  { from: 'config.json', to: 'workspace.json' },
  { from: 'sessions', to: 'sessions' },
  { from: 'sources', to: 'sources' },
  { from: 'skills', to: 'skills' },
  { from: 'statuses', to: 'statuses' },
  { from: 'labels', to: 'labels' },
  { from: 'projects', to: 'projects' },
  { from: 'messaging', to: 'messaging' },
  { from: 'automations.json', to: 'automations.json' },
  { from: 'automations-history.jsonl', to: 'automations-history.jsonl' },
  { from: 'automations-retry-queue.jsonl', to: 'automations-retry-queue.jsonl' },
  { from: 'views.json', to: 'views.json' },
  { from: 'permissions.json', to: 'permissions.json' },
  { from: 'events.jsonl', to: 'events.jsonl' },
  { from: 'theme.json', to: 'theme.json' },
];

// Directory-type legacy items, used for legacy-layout detection.
const LEGACY_DIRS = ['sessions', 'sources', 'skills', 'statuses', 'labels', 'projects', 'messaging'];

// Critical subdirectories ensured to exist so writers never hit ENOENT.
const CRITICAL_SUBDIRS = ['sessions', 'sources', 'skills', 'statuses', 'labels'];

/**
 * Migration completion marker (Issue #16 audit): written atomically AFTER all
 * items are moved and validated — the single commit point of the migration.
 * Existence of the marker means the namespace switch is complete; legacy root
 * files appearing later are treated as unrelated user files.
 */
const MIGRATION_MARKER_FILE = '.migrated.json';
const MIGRATION_MARKER_SCHEMA_VERSION = 1;

interface MigrationMarker {
  schemaVersion: number;
  completedAt: number;
  /** Destinations actually migrated by the run that wrote the marker */
  items: string[];
}

function writeMigrationMarker(nsDir: string, items: string[]): void {
  const marker: MigrationMarker = {
    schemaVersion: MIGRATION_MARKER_SCHEMA_VERSION,
    completedAt: Date.now(),
    items,
  };
  atomicWriteFileSync(
    join(nsDir, MIGRATION_MARKER_FILE),
    JSON.stringify(marker, null, 2)
  );
}

/**
 * Ensure critical namespace subdirectories exist for writers that don't
 * create their own parent directories (event-logger, history-store, views...).
 */
function ensureCriticalSubdirs(namespaceDir: string): void {
  for (const dir of CRITICAL_SUBDIRS) {
    const path = join(namespaceDir, dir);
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  }
}

/**
 * Idempotently migrate a workspace from the legacy root-level layout to the
 * .craft-agent/ namespace layout. Safe to call on every load; no-ops quickly
 * for migrated or fresh workspaces (single stat on the marker file).
 *
 * State machine (Issue #16 audit):
 *   1. Marker present → completed; return immediately. Legacy root files that
 *      reappear afterwards are unrelated user files — never touched.
 *   2. No marker + no legacy → fresh or old-code-migrated workspace: ensure
 *      namespace + critical subdirs, backfill the marker (no data touched).
 *   3. No marker + legacy + (namespace missing or empty) → normal migration:
 *      per-item rename (skip when destination exists), then validate every
 *      item that had a source (destination present, source gone). On failure
 *      (e.g. a move failed): NO marker, debug log, return — retried on next
 *      load. On success: write the marker (the commit point), ensure .gitignore.
 *   4. No marker + legacy + non-empty namespace → interrupted-migration
 *      detection: when every namespace entry is a migration destination or
 *      critical subdir, resume (case 3 logic). Unknown entries keep the
 *      explicit conflict behavior — warn, touch nothing, no marker.
 *
 * @param rootPath - Absolute path to workspace root folder
 */
export function ensureWorkspaceNamespace(rootPath: string): void {
  const nsDir = join(rootPath, WORKSPACE_NAMESPACE);
  const markerPath = join(nsDir, MIGRATION_MARKER_FILE);

  // State 1: migration already completed — the marker is the commit point.
  if (existsSync(markerPath)) return;

  const hasLegacy =
    existsSync(join(rootPath, 'config.json')) ||
    LEGACY_DIRS.some((d) => existsSync(join(rootPath, d)));

  // State 2: fresh workspace / non-workspace directory — nothing to migrate.
  // Only ensure the namespace exists for future writers and backfill the
  // marker so the fast path applies from now on. Best-effort: never throw
  // from a read path (e.g. read-only or invalid roots).
  if (!hasLegacy) {
    try {
      if (!existsSync(nsDir)) {
        mkdirSync(nsDir, { recursive: true });
      }
      ensureCriticalSubdirs(nsDir);
      writeMigrationMarker(nsDir, []);
    } catch (err) {
      debug(
        `[migrate-namespace] Could not ensure namespace at ${nsDir}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return;
  }

  debug(`[migrate-namespace] Migrating legacy layout at ${rootPath}`);

  // State 4 gate: non-empty namespace with legacy files — distinguish an
  // interrupted migration (resume) from unrelated content (explicit conflict).
  if (existsSync(nsDir)) {
    const nsContents = readdirSync(nsDir);
    if (nsContents.length > 0) {
      const allowed = new Set([
        ...MIGRATION_ITEMS.map((item) => item.to),
        ...CRITICAL_SUBDIRS,
      ]);
      const unknown = nsContents.filter((entry) => !allowed.has(entry));
      if (unknown.length > 0) {
        // Explicit conflict: refuse to merge into pre-existing namespace content
        console.warn(
          `[craft-agent] Workspace namespace conflict at ${rootPath}:\n` +
          `  .craft-agent/ already contains ${nsContents.length} item(s): ${nsContents.slice(0, 5).join(', ')}${nsContents.length > 5 ? '...' : ''}\n` +
          `  Legacy files also present at workspace root.\n` +
          `  Migration skipped to avoid overwriting existing content.\n` +
          `  Manual resolution required: move legacy files into .craft-agent/ or remove them.`
        );
        return; // Abort migration entirely, no marker
      }
      // Every entry is a migration destination or critical subdir → the
      // previous run crashed mid-migration; resume below.
      debug(`[migrate-namespace] Resuming interrupted migration at ${rootPath}`);
    }
  }

  if (!existsSync(nsDir)) {
    try {
      mkdirSync(nsDir, { recursive: true });
    } catch (err) {
      // Cannot create the namespace — abort migration; legacy fallback reads
      // (e.g. loadWorkspaceConfig) keep working against the old layout.
      debug(
        `[migrate-namespace] Cannot create ${nsDir}, skipping migration: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
  }

  // Track items that had a legacy source so completion validation below can
  // require their destination.
  const sourceExisted = new Set<string>();

  for (const item of MIGRATION_ITEMS) {
    const fromPath = join(rootPath, item.from);
    const toPath = join(nsDir, item.to);

    // Nothing at the legacy location — normal, skip.
    if (!existsSync(fromPath)) continue;
    sourceExisted.add(item.to);

    // Conflict: namespace already holds this item — never overwrite it.
    if (existsSync(toPath)) {
      debug(`[migrate-namespace] Skipping ${item.from} — ${item.to} already exists in namespace`);
      continue;
    }

    try {
      // Same filesystem (namespace is a subdirectory), rename is atomic.
      renameSync(fromPath, toPath);
    } catch {
      // Fallback for EXDEV / Windows lock scenarios: copy + delete.
      try {
        cpSync(fromPath, toPath, { recursive: true });
        rmSync(fromPath, { recursive: true, force: true });
      } catch (err) {
        debug(
          `[migrate-namespace] Failed to migrate ${item.from}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  ensureCriticalSubdirs(nsDir);

  // Completion validation: every item that had a source must have reached its
  // destination and no legacy source may remain. On any failure: NO marker —
  // the migration retries on the next load (never a false "completed").
  const migratedDestinations: string[] = [];
  let incomplete = false;
  for (const item of MIGRATION_ITEMS) {
    if (!sourceExisted.has(item.to)) continue;
    migratedDestinations.push(item.to);
    if (!existsSync(join(nsDir, item.to))) {
      incomplete = true;
    }
    if (existsSync(join(rootPath, item.from))) {
      incomplete = true;
    }
  }
  if (incomplete) {
    debug(`[migrate-namespace] Migration incomplete at ${rootPath}; retrying on next load`);
    return;
  }

  // Commit point: only after validation passes.
  writeMigrationMarker(nsDir, migratedDestinations);
  ensureGitIgnore(rootPath);
}

/**
 * Ensure a git repository's .gitignore covers the .craft-agent/ namespace.
 * No-op for non-git workspaces; appends (never overwrites) when missing.
 *
 * @param rootPath - Absolute path to workspace root folder
 */
export function ensureGitIgnore(rootPath: string): void {
  const gitDir = join(rootPath, '.git');
  if (!existsSync(gitDir)) return; // Not a git repository

  const gitignorePath = join(rootPath, '.gitignore');
  const entry = '.craft-agent/';
  const comment = '# Craft Agent workspace-local state';

  let existing = '';
  try {
    existing = readFileSync(gitignorePath, 'utf-8');
  } catch {
    // .gitignore doesn't exist yet — start from empty
  }

  // Already covered
  if (existing.includes('.craft-agent/')) return;

  // Append (do not overwrite). appendFileSync is not atomic, but .gitignore is
  // a plain text file with lower crash-safety requirements than data files.
  const append = existing && !existing.endsWith('\n')
    ? `\n\n${comment}\n${entry}\n`
    : `\n${comment}\n${entry}\n`;
  appendFileSync(gitignorePath, append, 'utf-8');
}
