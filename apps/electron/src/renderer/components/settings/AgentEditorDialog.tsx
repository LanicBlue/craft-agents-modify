/**
 * AgentEditorDialog — Create / Edit AgentProfile dialog (Issue #15 Step 3).
 *
 * Create mode (agent = null): all fields empty, required: name, systemPrompt,
 * execution kind.
 *
 * Edit mode (agent set): metadata prefilled from AgentRecord; configuration
 * fields prefilled from the agent's LATEST revision (fetched via
 * getLatestAgentRevision). Agent ID is read-only (AC#2).
 *
 * Save semantics (mirror updateAgent from #2):
 * - metadata-only changes (name/description) → "Save Changes" (no new revision)
 * - any configuration change → "Save as Revision N+1" (new immutable revision)
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  SettingsInput,
  SettingsSelect,
  SettingsSegmentedControl,
  SettingsTextarea,
} from '@/components/settings'
import { useRegisterModal } from '@/context/ModalContext'
import type { AgentRecord, AgentProfileRevision, CreateAgentInput, UpdateAgentInput, AgentExecutionConfig, AgentBindingDiagnostics } from '@craft-agent/shared/agents'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import type { PermissionMode } from '@craft-agent/shared/agent/modes'
import type { HarnessOptions } from '@craft-agent/shared/agent/backend'

export interface AgentEditorDialogProps {
  open: boolean
  /** Agent to edit, or null for create mode */
  agent: AgentRecord | null
  onCancel: () => void
  onSaved: () => void
  create: (input: CreateAgentInput) => Promise<AgentRecord>
  update: (agentId: string, input: UpdateAgentInput, expectedRecordVersion?: number) => Promise<AgentRecord>
  getLatestRevision: (agentId: string) => Promise<AgentProfileRevision>
  /** Workspace list for runtime-binding diagnostics (Issue #15) */
  listWorkspaces: () => Promise<Array<{ id: string; name: string }>>
  /** Per-workspace binding diagnostics for the runtime-binding section */
  listAgentBindings: (workspaceId: string) => Promise<AgentBindingDiagnostics[]>
  /** Harness option ranges (Issue #17 W7) — null when the harness can't report */
  listHarnessOptions: (harness: string) => Promise<HarnessOptions | null>
}

const THINKING_OPTIONS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
const PERMISSION_OPTIONS: PermissionMode[] = ['safe', 'ask', 'allow-all']
/** Harnesses validated for production (real-machine Gate B): claude + pi. */
const SELECTABLE_HARNESS = ['claude', 'pi'] as const
const HARNESS_OPTIONS = ['codex', 'claude', 'kimi', 'pi'] as const
const CONFIG_MODE_OPTIONS = ['local-inherit', 'managed'] as const

/** Stable id format (Issue #2) — server-side validation is authoritative. */
const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/** Parse "a, b, c" → ["a","b","c"]; empty → undefined */
function parseSources(raw: string): string[] | undefined {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parts.length > 0 ? parts : undefined
}

export function AgentEditorDialog({
  open,
  agent,
  onCancel,
  onSaved,
  create,
  update,
  getLatestRevision,
  listWorkspaces,
  listAgentBindings,
  listHarnessOptions,
}: AgentEditorDialogProps) {
  const { t } = useTranslation()
  const isEdit = agent !== null

  // --- Form state ---
  const [name, setName] = React.useState('')
  const [agentId, setAgentId] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [kind, setKind] = React.useState<'craft-backend' | 'external-harness'>('craft-backend')
  const [llmConnection, setLlmConnection] = React.useState('')
  const [model, setModel] = React.useState('')
  const [harness, setHarness] = React.useState<string>('claude')
  const [configMode, setConfigMode] = React.useState<string>('local-inherit')
  const [thinkingLevel, setThinkingLevel] = React.useState<string>('medium')
  const [permissionMode, setPermissionMode] = React.useState<string>('ask')
  const [sources, setSources] = React.useState('')
  const [systemPrompt, setSystemPrompt] = React.useState('')

  const [revision, setRevision] = React.useState<AgentProfileRevision | null>(null)
  const [isLoadingRevision, setIsLoadingRevision] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [isSaving, setIsSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)

  // --- Harness option ranges (Issue #17 W7) ---
  // Cache survives dialog close/open (keyed by harness); null is cached too —
  // a failed fetch is never retried on every open (claude spins up a CLI).
  const [optionsCache, setOptionsCache] = React.useState<Record<string, HarnessOptions | null>>({})
  const [isLoadingOptions, setIsLoadingOptions] = React.useState(false)

  // --- Runtime binding diagnostics (edit mode only, read-only) ---
  interface BindingRow {
    workspaceName: string
    state?: string
    generation?: number
    sessionProfileRevision?: number
  }
  const [bindingRows, setBindingRows] = React.useState<BindingRow[] | null>(null)

  React.useEffect(() => {
    if (!open || !agent) return
    let cancelled = false
    setBindingRows(null)
    listWorkspaces()
      .then(async (workspaces) => {
        const rows: BindingRow[] = []
        for (const w of workspaces) {
          try {
            const bindings = await listAgentBindings(w.id)
            const mine = bindings.find((b) => b.agentId === agent.id)
            if (mine) {
              rows.push({
                workspaceName: w.name,
                state: mine.state,
                generation: mine.generation,
                sessionProfileRevision: mine.sessionProfileRevision,
              })
            }
          } catch {
            // fail-soft: a single workspace query failure never breaks the dialog
          }
        }
        if (!cancelled) setBindingRows(rows)
      })
      .catch(() => {
        if (!cancelled) setBindingRows([])
      })
    return () => {
      cancelled = true
    }
  }, [open, agent, listWorkspaces, listAgentBindings])

  // Fetch harness option ranges when an external-harness is selected and not
  // yet cached (Issue #17 W7). Failures are cached as null (fail-soft — the
  // UI falls back to hardcoded lists) and never surfaced as an error toast.
  React.useEffect(() => {
    if (!open || kind !== 'external-harness') return
    if (optionsCache[harness] !== undefined) return
    let cancelled = false
    setIsLoadingOptions(true)
    listHarnessOptions(harness)
      .then((options) => {
        if (!cancelled) setOptionsCache((prev) => ({ ...prev, [harness]: options }))
      })
      .catch(() => {
        // fail-soft: cache the failure so we never retry on every open
        if (!cancelled) setOptionsCache((prev) => ({ ...prev, [harness]: null }))
      })
      .finally(() => {
        if (!cancelled) setIsLoadingOptions(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, kind, harness, optionsCache, listHarnessOptions])

  useRegisterModal(open, onCancel)

  // Load current values whenever the dialog opens for an agent
  React.useEffect(() => {
    if (!open) return
    setName(agent?.name ?? '')
    setAgentId('')
    setDescription(agent?.description ?? '')
    setSystemPrompt('')
    setKind('craft-backend')
    setLlmConnection('')
    setModel('')
    setHarness('claude')
    setConfigMode('local-inherit')
    setThinkingLevel('medium')
    setPermissionMode('ask')
    setSources('')
    setRevision(null)
    setLoadError(null)
    setSaveError(null)

    if (!agent) return
    setIsLoadingRevision(true)
    getLatestRevision(agent.id)
      .then((rev) => {
        setRevision(rev)
        setKind(rev.execution.kind)
        if (rev.execution.kind === 'craft-backend') {
          setLlmConnection(rev.execution.llmConnection ?? '')
          setModel(rev.execution.model ?? '')
        } else {
          setHarness(rev.execution.harness)
          setModel(rev.execution.model ?? '')
          setConfigMode(rev.execution.configMode ?? 'local-inherit')
        }
        setThinkingLevel(rev.thinkingLevel ?? 'medium')
        setPermissionMode(rev.permissionMode ?? 'ask')
        setSources((rev.enabledSourceSlugs ?? []).join(', '))
        setSystemPrompt(rev.systemPrompt)
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load agent revision')
      })
      .finally(() => setIsLoadingRevision(false))
  }, [open, agent, getLatestRevision])

  // --- Change detection (edit mode) ---
  const metadataChanged =
    isEdit && (name !== agent!.name || description !== (agent!.description ?? ''))

  const executionChanged = React.useMemo(() => {
    if (!isEdit || !revision) return false
    const exec = revision.execution
    if (kind !== exec.kind) return true
    if (exec.kind === 'craft-backend') {
      return llmConnection !== (exec.llmConnection ?? '') || model !== (exec.model ?? '')
    }
    return (
      harness !== exec.harness ||
      model !== (exec.model ?? '') ||
      configMode !== (exec.configMode ?? 'local-inherit')
    )
  }, [isEdit, revision, kind, llmConnection, model, harness, configMode])

  const systemPromptChanged = isEdit && !!revision && systemPrompt !== revision.systemPrompt
  const thinkingLevelChanged = isEdit && !!revision && thinkingLevel !== (revision.thinkingLevel ?? 'medium')
  const permissionModeChanged = isEdit && !!revision && permissionMode !== (revision.permissionMode ?? 'ask')
  const sourcesChanged =
    isEdit && !!revision && parseSources(sources)?.join(',') !== (revision.enabledSourceSlugs ?? []).join(',')

  const hasConfigChange =
    executionChanged || systemPromptChanged || thinkingLevelChanged || permissionModeChanged || sourcesChanged

  // --- Option ranges from the selected harness (Issue #17 W7) ---
  // Every range unions the CURRENT value: a custom value on an old revision
  // must stay visible and selectable even when the harness doesn't report it.
  const harnessOptions = kind === 'external-harness' ? (optionsCache[harness] ?? null) : null
  const harnessModels = harnessOptions?.models?.length
    ? [...new Set([...harnessOptions.models.map((m) => m.id), ...(model.trim() ? [model.trim()] : [])])].map(
        (id) => ({ value: id, label: harnessOptions.models.find((m) => m.id === id)?.name ?? id }),
      )
    : null
  const modelThinkingLevels = harnessOptions?.models.find((m) => m.id === model)?.thinkingLevels
  const thinkingOptions = modelThinkingLevels?.length
    ? [...new Set([...modelThinkingLevels, thinkingLevel])]
    : [...THINKING_OPTIONS]
  const permissionOptions = harnessOptions?.permissionModes?.length
    ? [...new Set([...harnessOptions.permissionModes, permissionMode as PermissionMode])]
    : [...PERMISSION_OPTIONS]

  // --- Client-side id validation (create mode only; server is authoritative) ---
  const trimmedId = agentId.trim()
  const idInvalid = !isEdit && trimmedId.length > 0 && !AGENT_ID_PATTERN.test(trimmedId)

  const canSave = isEdit
    ? metadataChanged || hasConfigChange
    : name.trim().length > 0 && systemPrompt.trim().length > 0 && trimmedId.length > 0 && !idInvalid

  const buildExecution = (): AgentExecutionConfig => {
    if (kind === 'craft-backend') {
      const execution: AgentExecutionConfig = { kind: 'craft-backend' }
      if (llmConnection.trim()) execution.llmConnection = llmConnection.trim()
      if (model.trim()) execution.model = model.trim()
      return execution
    }
    const execution: AgentExecutionConfig = {
      kind: 'external-harness',
      harness: harness as 'codex' | 'claude' | 'kimi' | 'pi',
    }
    if (model.trim()) execution.model = model.trim()
    // pi is local-inherit only in P0 (the driver rejects managed explicitly).
    execution.configMode = harness === 'pi' ? 'local-inherit' : (configMode as 'local-inherit' | 'managed')
    return execution
  }

  const handleSave = async () => {
    if (!canSave || isSaving) return
    setIsSaving(true)
    setSaveError(null)
    try {
      if (!isEdit) {
        const input: CreateAgentInput = {
          id: trimmedId,
          name: name.trim(),
          systemPrompt: systemPrompt.trim(),
          execution: buildExecution(),
        }
        if (description.trim()) input.description = description.trim()
        if (thinkingLevel !== 'medium') input.thinkingLevel = thinkingLevel as ThinkingLevel
        if (permissionMode !== 'ask') input.permissionMode = permissionMode as PermissionMode
        const parsed = parseSources(sources)
        if (parsed) input.enabledSourceSlugs = parsed
        await create(input)
      } else {
        const updates: UpdateAgentInput = {}
        if (name !== agent!.name) updates.name = name.trim()
        if (description !== (agent!.description ?? '')) updates.description = description.trim()
        if (executionChanged) updates.execution = buildExecution()
        if (systemPromptChanged) updates.systemPrompt = systemPrompt.trim()
        if (thinkingLevelChanged) updates.thinkingLevel = thinkingLevel as ThinkingLevel
        if (permissionModeChanged) updates.permissionMode = permissionMode as PermissionMode
        if (sourcesChanged) {
          const parsed = parseSources(sources)
          updates.enabledSourceSlugs = parsed ?? []
        }
        await update(agent!.id, updates, agent!.recordVersion)
      }
      onSaved()
    } catch (err) {
      // Surface server-side errors verbatim (e.g. AGENT_ID_INVALID from the
      // authoritative storage validation) — never silently normalize.
      setSaveError(err instanceof Error ? err.message : 'Failed to save agent')
    } finally {
      setIsSaving(false)
    }
  }

  const nextRevision = isEdit ? (agent!.latestProfileRevision + 1).toString() : null

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('settings.agents.edit') : t('settings.agents.create')}
          </DialogTitle>
        </DialogHeader>

        {isEdit && (
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono text-muted-foreground">{agent!.id}</span>
            <Badge variant={agent!.status === 'active' ? 'default' : 'secondary'}>
              {agent!.status === 'active' ? t('settings.agents.active') : t('settings.agents.retired')}
            </Badge>
          </div>
        )}

        {isEdit && isLoadingRevision ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="pt-2 space-y-5">
            {loadError && (
              <p className="text-sm text-destructive">{loadError}</p>
            )}
            {saveError && (
              <p className="text-sm text-destructive">{saveError}</p>
            )}

            {/* Identity */}
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('settings.agents.identity')}
              </p>
              {!isEdit && (
                <SettingsInput
                  label={t('settings.agents.idLabel')}
                  value={agentId}
                  onChange={setAgentId}
                  placeholder={t('settings.agents.idLabel')}
                  error={idInvalid ? t('settings.agents.idInvalid') : undefined}
                />
              )}
              <SettingsInput
                label={t('settings.agents.name')}
                value={name}
                onChange={setName}
                placeholder={t('settings.agents.name')}
              />
              <SettingsInput
                label={t('settings.agents.descriptionLabel')}
                value={description}
                onChange={setDescription}
                placeholder={t('settings.agents.descriptionLabel')}
              />
            </div>

            {/* Runtime bindings (diagnostics-only, read-only — Issue #15) */}
            {isEdit && bindingRows !== null && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {t('settings.agents.runtimeBindings')}
                </p>
                {bindingRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t('settings.agents.noBindings')}
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {bindingRows.map((row) => (
                      <div
                        key={row.workspaceName}
                        className="flex items-center gap-2 text-sm"
                      >
                        <span className="flex-1 truncate">{row.workspaceName}</span>
                        <Badge
                          variant={
                            row.state === 'conflict'
                              ? 'destructive'
                              : row.state === 'bound'
                                ? 'default'
                                : 'secondary'
                          }
                        >
                          {row.state === 'bound'
                            ? t('settings.agents.bindingBound')
                            : row.state === 'conflict'
                              ? t('settings.agents.bindingConflict')
                              : t('settings.agents.bindingUnbound')}
                        </Badge>
                        <span className="font-mono text-xs text-muted-foreground">
                          {t('settings.agents.generation', { n: row.generation ?? '—' })}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {t('settings.agents.sessionRevision', {
                            m: row.sessionProfileRevision ?? '—',
                          })}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Execution */}
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('settings.agents.execution')}
              </p>
              <SettingsSegmentedControl
                value={kind}
                onValueChange={(v) => setKind(v as 'craft-backend' | 'external-harness')}
                options={[
                  { value: 'craft-backend', label: t('settings.agents.craftBackend') },
                  { value: 'external-harness', label: t('settings.agents.externalHarness') },
                ]}
              />
              {kind === 'craft-backend' ? (
                <>
                  <SettingsInput
                    label={t('settings.agents.llmConnection')}
                    value={llmConnection}
                    onChange={setLlmConnection}
                    placeholder={t('settings.agents.llmConnection')}
                  />
                  <SettingsInput
                    label={t('settings.agents.model')}
                    value={model}
                    onChange={setModel}
                    placeholder={t('settings.agents.model')}
                  />
                </>
              ) : (
                // Harness selection exposes the VALIDATED harnesses (claude/pi,
                // real-machine Gate B); a pre-existing codex/kimi revision keeps
                // its value visible but can be switched to a supported one.
                <>
                  <SettingsSelect
                    label={t('settings.agents.harness')}
                    value={harness}
                    onValueChange={(v) => {
                      setHarness(v)
                      if (v === 'pi') setConfigMode('local-inherit')
                    }}
                    options={[...new Set([...SELECTABLE_HARNESS, harness as (typeof HARNESS_OPTIONS)[number]])].map(
                      (h) => ({ value: h, label: h }),
                    )}
                  />
                  {harnessModels ? (
                    <SettingsSelect
                      label={t('settings.agents.model')}
                      value={model}
                      onValueChange={setModel}
                      options={harnessModels}
                    />
                  ) : (
                    <SettingsInput
                      label={t('settings.agents.model')}
                      value={model}
                      onChange={setModel}
                      placeholder={t('settings.agents.model')}
                    />
                  )}
                  {harness === 'claude' && (
                    <SettingsSelect
                      label={t('settings.agents.configMode')}
                      value={configMode}
                      onValueChange={setConfigMode}
                      options={CONFIG_MODE_OPTIONS.map((c) => ({ value: c, label: c }))}
                    />
                  )}
                  {isLoadingOptions && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {t('common.loading')}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Runtime Config */}
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('settings.agents.runtimeConfig')}
              </p>
              <SettingsSelect
                label={t('settings.agents.thinkingLevel')}
                value={thinkingLevel}
                onValueChange={setThinkingLevel}
                options={thinkingOptions.map((v) => ({ value: v, label: v }))}
              />
              <SettingsSelect
                label={t('settings.agents.permissionMode')}
                value={permissionMode}
                onValueChange={setPermissionMode}
                options={permissionOptions.map((v) => ({ value: v, label: v }))}
              />
              <SettingsInput
                label={t('settings.agents.enabledSources')}
                value={sources}
                onChange={setSources}
                placeholder="github, linear"
              />
            </div>

            {/* Role */}
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('settings.agents.role')}
              </p>
              <SettingsTextarea
                label={t('settings.agents.systemPrompt')}
                value={systemPrompt}
                onChange={setSystemPrompt}
                rows={6}
              />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!canSave || isSaving || (isEdit && isLoadingRevision)} onClick={handleSave}>
            {isEdit
              ? hasConfigChange
                ? t('settings.agents.saveAsRevision', { n: nextRevision })
                : t('settings.agents.saveChanges')
              : t('settings.agents.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
