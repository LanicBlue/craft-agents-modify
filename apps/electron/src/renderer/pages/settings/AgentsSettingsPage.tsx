/**
 * AgentsSettingsPage
 *
 * Lists the global AgentProfile registry (Issue #15).
 *
 * - Agent IDs are shown read-only — never editable (AC#2).
 * - Retired agents remain visible (includeRetired) so they can be restored
 *   later (AC#5).
 * - This page is independent of any workspace: agent profiles are global and
 *   distinct from workspace defaults (AC#6).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Loader2 } from 'lucide-react'
import { formatDistanceToNowStrict, type Locale } from 'date-fns'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EntityRow } from '@/components/ui/entity-row'
import { Badge } from '@/components/ui/badge'
import { SettingsSection, SettingsCard } from '@/components/settings'
import { useAgents } from '@/hooks/useAgents'
import { shortTimeLocale } from '@/utils/session'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'agents',
}

export default function AgentsSettingsPage() {
  const { t } = useTranslation()
  const { agents, isLoading, error } = useAgents({ includeRetired: true })

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t('settings.agents.title')} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {/* About Section */}
              <SettingsSection title={t('settings.agents.title')}>
                <SettingsCard className="px-4 py-3.5">
                  <div className="text-sm text-muted-foreground leading-relaxed">
                    <p>{t('settings.agents.description')}</p>
                  </div>
                </SettingsCard>
              </SettingsSection>

              {/* Agent List Section */}
              <SettingsSection title={t('settings.agents.agentList')}>
                <SettingsCard className="p-0">
                  {isLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : error ? (
                    <div className="p-8 text-center text-muted-foreground">
                      <p className="text-sm">{error}</p>
                    </div>
                  ) : agents.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">
                      <p className="text-sm">{t('settings.agents.noAgents')}</p>
                    </div>
                  ) : (
                    <div>
                      {agents.map((agent, index) => (
                        <EntityRow
                          key={agent.id}
                          icon={<Bot className="w-4 h-4" />}
                          title={agent.name}
                          titleSuffix={
                            <span className="font-mono text-xs text-muted-foreground">
                              {agent.id}
                            </span>
                          }
                          badges={
                            <>
                              <Badge variant={agent.status === 'active' ? 'default' : 'secondary'}>
                                {agent.status === 'active'
                                  ? t('settings.agents.active')
                                  : t('settings.agents.retired')}
                              </Badge>
                              <span className="text-xs text-muted-foreground">
                                {t('settings.agents.revision')} {agent.latestRevision}
                              </span>
                            </>
                          }
                          trailing={
                            <span className="text-xs text-muted-foreground">
                              {formatDistanceToNowStrict(new Date(agent.updatedAt), {
                                locale: shortTimeLocale as Locale,
                                roundingMethod: 'floor',
                              })}
                            </span>
                          }
                          showSeparator={index > 0}
                        />
                      ))}
                    </div>
                  )}
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
