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
  lstatSync,
  readlinkSync,
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

// Directory-type legacy items, used for critical-subdir creation below.
// Legacy-layout detection uses MIGRATION_ITEMS (covers config.json + dirs +
// file-type items) — see hasLegacy.
const CRITICAL_SUBDIRS = ['sessions', 'sources', 'skills', 'statuses', 'labels'];

/**
 * Detect a legacy layout: ANY migration item (file- or directory-type) still
 * present at the workspace root — config.json and the legacy dirs are all in
 * MIGRATION_ITEMS, so a single pass over the list is complete. Without this,
 * a leftover automations.json / views.json / permissions.json / events.jsonl
 * / theme.json / automations-history.jsonl / automations-retry-queue.jsonl
 * after config.json was already moved would be silently treated as "fresh"
 * (false completion marker + file stranded at the root forever).
 */
function hasLegacyRootItems(rootPath: string): boolean {
  return MIGRATION_ITEMS.some((item) => existsSync(join(rootPath, item.from)));
}

/**
 * Prove that a source and destination contain the same data before deleting
 * the source of an interrupted copy+delete fallback. Existence alone is not
 * proof: cpSync can leave a partial destination when it throws, and a
 * same-named namespace entry may predate the migration.
 */
function pathsEquivalent(sourcePath: string, destinationPath: string): boolean {
  try {
    const source = lstatSync(sourcePath);
    const destination = lstatSync(destinationPath);

    if (source.isSymbolicLink() || destination.isSymbolicLink()) {
      return (
        source.isSymbolicLink() &&
        destination.isSymbolicLink() &&
        readlinkSync(sourcePath) === readlinkSync(destinationPath)
      );
    }

    if (source.isFile() || destination.isFile()) {
      return (
        source.isFile() &&
        destination.isFile() &&
        source.size === destination.size &&
        readFileSync(sourcePath).equals(readFileSync(destinationPath))
      );
    }

    if (source.isDirectory() || destination.isDirectory()) {
      if (!source.isDirectory() || !destination.isDirectory()) return false;
      const sourceEntries = readdirSync(sourcePath).sort();
      const destinationEntries = readdirSync(destinationPath).sort();
      if (
        sourceEntries.length !== destinationEntries.length ||
        sourceEntries.some((entry, index) => entry !== destinationEntries[index])
      ) {
        return false;
      }
      return sourceEntries.every((entry) =>
        pathsEquivalent(join(sourcePath, entry), join(destinationPath, entry))
      );
    }

    // Sockets/devices and other special entries are never safe to reconcile
    // automatically during workspace metadata migration.
    return false;
  } catch {
    return false;
  }
}

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

  const hasLegacy = hasLegacyRootItems(rootPath);

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
        // Bindings directory created by new code under the namespace (#4) —
        // must not turn an interrupted migration into a false conflict.
        'agent-sessions',
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
  // require their destination. Items whose copy completed but whose source
  // could not be deleted (cp-fallback rm failure) are tracked as stuck.
  const sourceExisted = new Set<string>();
  const stuckItems = new Set<string>();

  for (const item of MIGRATION_ITEMS) {
    const fromPath = join(rootPath, item.from);
    const toPath = join(nsDir, item.to);

    // Nothing at the legacy location — normal, skip.
    if (!existsSync(fromPath)) continue;
    sourceExisted.add(item.to);

    // Namespace already holds this item. Only a byte/tree-equivalent target
    // proves that the copy phase completed and source deletion may be retried.
    if (existsSync(toPath)) {
      if (!pathsEquivalent(fromPath, toPath)) {
        stuckItems.add(item.to);
        debug(
          `[migrate-namespace] Source and destination differ for ${item.from}; refusing to delete either side`
        );
        continue;
      }

      // Equivalent source + destination means copy completed but delete did
      // not. Retrying the delete safely completes that item.
      try {
        rmSync(fromPath, { recursive: true, force: true });
        debug(`[migrate-namespace] Removed leftover legacy source ${item.from} after completed copy`);
      } catch (err) {
        stuckItems.add(item.to);
        debug(
          `[migrate-namespace] Cannot remove stuck legacy source ${item.from}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
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
        // Copy completed but the source could not be removed (or the copy
        // itself failed) — if the destination now exists the item is stuck
        // and surfaces as an explicit conflict, never a silent retry loop.
        if (existsSync(toPath)) {
          stuckItems.add(item.to);
        }
        debug(
          `[migrate-namespace] Failed to migrate ${item.from}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  ensureCriticalSubdirs(nsDir);

  // Stuck/conflicting sources: deletion failed or the destination could not
  // be proven equivalent. Explicit conflict — no marker and both copies of
  // every conflicting item remain available for manual resolution.
  if (stuckItems.size > 0) {
    console.warn(
      `[craft-agent] Workspace migration stuck at ${rootPath}:\n` +
      `  Legacy items cannot be reconciled safely: ${[...stuckItems].join(', ')}.\n` +
      `  Migration skipped — no completion marker written.\n` +
      `  Manual resolution required: verify the source and destination contents, then remove the obsolete copy or grant write permission.`
    );
    return;
  }

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
