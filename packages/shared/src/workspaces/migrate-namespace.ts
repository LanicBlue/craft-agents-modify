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
} from 'fs';
import { join } from 'path';
// NOTE: circular import with ./storage.ts is safe — WORKSPACE_NAMESPACE is only
// accessed inside function bodies, never at module initialization time.
import { WORKSPACE_NAMESPACE } from './storage.ts';
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
 * for migrated or fresh workspaces.
 *
 * Conflict policy: items already present in .craft-agent/ are never overwritten
 * or touched — only missing targets are migrated from the legacy locations.
 *
 * @param rootPath - Absolute path to workspace root folder
 */
export function ensureWorkspaceNamespace(rootPath: string): void {
  const nsDir = join(rootPath, WORKSPACE_NAMESPACE);
  const nsConfig = join(nsDir, 'workspace.json');
  const legacyConfig = join(rootPath, 'config.json');

  const hasLegacy =
    existsSync(legacyConfig) || LEGACY_DIRS.some((d) => existsSync(join(rootPath, d)));

  // Fast path 1: already migrated (namespaced config present, no legacy config).
  if (existsSync(nsConfig) && !existsSync(legacyConfig)) return;

  // Fast path 2: fresh workspace / non-workspace directory — nothing to migrate.
  // Only ensure the namespace exists for future writers. Best-effort: never
  // throw from a read path (e.g. read-only or invalid roots).
  if (!hasLegacy) {
    try {
      if (!existsSync(nsDir)) {
        mkdirSync(nsDir, { recursive: true });
      }
      ensureCriticalSubdirs(nsDir);
    } catch (err) {
      debug(
        `[migrate-namespace] Could not ensure namespace at ${nsDir}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return;
  }

  debug(`[migrate-namespace] Migrating legacy layout at ${rootPath}`);

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

  for (const item of MIGRATION_ITEMS) {
    const fromPath = join(rootPath, item.from);
    const toPath = join(nsDir, item.to);

    // Nothing at the legacy location — normal, skip.
    if (!existsSync(fromPath)) continue;

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
