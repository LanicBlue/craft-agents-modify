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
  SettingsTextarea,
} from '@/components/settings'
import { useRegisterModal } from '@/context/ModalContext'
import type { AgentRecord, AgentProfileRevision, CreateAgentInput, UpdateAgentInput, AgentExecutionConfig } from '@craft-agent/shared/agents'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import type { PermissionMode } from '@craft-agent/shared/agent/modes'

export interface AgentEditorDialogProps {
  open: boolean
  /** Agent to edit, or null for create mode */
  agent: AgentRecord | null
  onCancel: () => void
  onSaved: () => void
  create: (input: CreateAgentInput) => Promise<AgentRecord>
  update: (agentId: string, input: UpdateAgentInput) => Promise<AgentRecord>
  getLatestRevision: (agentId: string) => Promise<AgentProfileRevision>
}

const THINKING_OPTIONS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
const PERMISSION_OPTIONS: PermissionMode[] = ['safe', 'ask', 'allow-all']
const HARNESS_OPTIONS = ['codex', 'claude', 'kimi'] as const
const CONFIG_MODE_OPTIONS = ['local-inherit', 'managed'] as const

/**
 * P0 scope (#15/#17): the editor only exposes craft-backend. External-harness
 * execution stays a first-class citizen in the domain model, but the P0 UI
 * never creates or edits it — an existing external-harness revision renders
 * read-only so a save can never silently convert the execution kind.
 */
const EDITOR_KIND: 'craft-backend' = 'craft-backend'

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
}: AgentEditorDialogProps) {
  const { t } = useTranslation()
  const isEdit = agent !== null

  // --- Form state ---
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  // 'external-harness' only ever appears when EDITING an agent whose latest
  // revision already uses it — never selectable, never editable (read-only).
  const [kind, setKind] = React.useState<'craft-backend' | 'external-harness'>(EDITOR_KIND)
  const [llmConnection, setLlmConnection] = React.useState('')
  const [model, setModel] = React.useState('')
  const [harness, setHarness] = React.useState<string>('codex')
  const [configMode, setConfigMode] = React.useState<string>('managed')
  const [thinkingLevel, setThinkingLevel] = React.useState<string>('medium')
  const [permissionMode, setPermissionMode] = React.useState<string>('ask')
  const [sources, setSources] = React.useState('')
  const [systemPrompt, setSystemPrompt] = React.useState('')

  const [revision, setRevision] = React.useState<AgentProfileRevision | null>(null)
  const [isLoadingRevision, setIsLoadingRevision] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [isSaving, setIsSaving] = React.useState(false)

  useRegisterModal(open, onCancel)

  // Load current values whenever the dialog opens for an agent
  React.useEffect(() => {
    if (!open) return
    setName(agent?.name ?? '')
    setDescription(agent?.description ?? '')
    setSystemPrompt('')
    setKind(EDITOR_KIND)
    setLlmConnection('')
    setModel('')
    setHarness('codex')
    setConfigMode('managed')
    setThinkingLevel('medium')
    setPermissionMode('ask')
    setSources('')
    setRevision(null)
    setLoadError(null)

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
          setConfigMode(rev.execution.configMode ?? 'managed')
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
    // External-harness execution is read-only in the P0 editor (#15) — it is
    // never diffed, so a save never rewrites or converts it.
    if (exec.kind !== 'craft-backend') return false
    if (kind !== exec.kind) return true
    return llmConnection !== (exec.llmConnection ?? '') || model !== (exec.model ?? '')
  }, [isEdit, revision, kind, llmConnection, model])

  const systemPromptChanged = isEdit && !!revision && systemPrompt !== revision.systemPrompt
  const thinkingLevelChanged = isEdit && !!revision && thinkingLevel !== (revision.thinkingLevel ?? 'medium')
  const permissionModeChanged = isEdit && !!revision && permissionMode !== (revision.permissionMode ?? 'ask')
  const sourcesChanged =
    isEdit && !!revision && parseSources(sources)?.join(',') !== (revision.enabledSourceSlugs ?? []).join(',')

  const hasConfigChange =
    executionChanged || systemPromptChanged || thinkingLevelChanged || permissionModeChanged || sourcesChanged

  const canSave = isEdit
    ? metadataChanged || hasConfigChange
    : name.trim().length > 0 && systemPrompt.trim().length > 0

  const buildExecution = (): AgentExecutionConfig => {
    if (kind === 'craft-backend') {
      const execution: AgentExecutionConfig = { kind: 'craft-backend' }
      if (llmConnection.trim()) execution.llmConnection = llmConnection.trim()
      if (model.trim()) execution.model = model.trim()
      return execution
    }
    const execution: AgentExecutionConfig = {
      kind: 'external-harness',
      harness: harness as 'codex' | 'claude' | 'kimi',
    }
    if (model.trim()) execution.model = model.trim()
    execution.configMode = configMode as 'local-inherit' | 'managed'
    return execution
  }

  const handleSave = async () => {
    if (!canSave || isSaving) return
    setIsSaving(true)
    try {
      if (!isEdit) {
        const input: CreateAgentInput = {
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
        await update(agent!.id, updates)
      }
      onSaved()
    } finally {
      setIsSaving(false)
    }
  }

  const nextRevision = isEdit ? (agent!.latestRevision + 1).toString() : null

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

            {/* Identity */}
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('settings.agents.identity')}
              </p>
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

            {/* Execution */}
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('settings.agents.execution')}
              </p>
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
                // Existing external-harness agent: read-only display (#15 — the
                // P0 editor exposes craft-backend only and never converts).
                <>
                  <SettingsSelect
                    label={t('settings.agents.harness')}
                    value={harness}
                    onValueChange={setHarness}
                    disabled
                    options={HARNESS_OPTIONS.map((h) => ({ value: h, label: h }))}
                  />
                  <SettingsInput
                    label={t('settings.agents.model')}
                    value={model}
                    onChange={setModel}
                    placeholder={t('settings.agents.model')}
                    disabled
                  />
                  <SettingsSelect
                    label={t('settings.agents.configMode')}
                    value={configMode}
                    onValueChange={setConfigMode}
                    disabled
                    options={CONFIG_MODE_OPTIONS.map((c) => ({ value: c, label: c }))}
                  />
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
                options={THINKING_OPTIONS.map((v) => ({ value: v, label: v }))}
              />
              <SettingsSelect
                label={t('settings.agents.permissionMode')}
                value={permissionMode}
                onValueChange={setPermissionMode}
                options={PERMISSION_OPTIONS.map((v) => ({ value: v, label: v }))}
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
