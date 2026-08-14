/**
 * StatusIcon - Thin wrapper around EntityIcon for statuses.
 *
 * Sets fallbackIcon={Circle}. Color is NOT handled here — the parent applies
 * a Tailwind color class (e.g. 'text-success') which cascades into colorable
 * SVGs via CSS currentColor inheritance.
 *
 * Status icons are discovered at `.craft-agent/statuses/icons/{statusId}.{ext}`.
 */

import { Circle } from 'lucide-react'
import { EntityIcon } from '@/components/ui/entity-icon'
import { useEntityIcon } from '@/lib/icon-cache'
import type { IconSize } from '@craft-agent/shared/icons'

const LOCAL_STATUS_ICON_FILENAME_PATTERN = /^[^/\\]+\.(svg|png|jpe?g|webp)$/i

interface StatusIconProps {
  /** Status identifier (used to discover icon file) */
  statusId: string
  /** Icon value from config (emoji string) */
  icon?: string
  /** Workspace ID for loading local icons */
  workspaceId: string
  /** Size variant (default: 'sm' - statuses are typically small) */
  size?: IconSize
  /** Additional className */
  className?: string
  /** When true, emoji icons render without container chrome (bg, ring, rounded) */
  chromeless?: boolean
  /** When true, renders without any container (just the SVG/emoji) */
  bare?: boolean
}

export function resolveStatusIconSource(
  statusId: string,
  icon?: string
): { iconPath?: string; iconValue?: string; iconFileName?: string } {
  const trimmedIcon = typeof icon === 'string' ? icon.trim() : undefined

  if (trimmedIcon && LOCAL_STATUS_ICON_FILENAME_PATTERN.test(trimmedIcon)) {
    return {
      // Workspace-relative paths are namespaced under .craft-agent/ (must stay
      // in sync with WORKSPACE_NAMESPACE in packages/shared/src/workspaces/storage.ts).
      iconPath: `.craft-agent/statuses/icons/${trimmedIcon}`,
    }
  }

  return {
    iconValue: trimmedIcon,
    iconFileName: statusId,
  }
}

export function StatusIcon({
  statusId,
  icon,
  workspaceId,
  size = 'sm',
  className,
  chromeless,
  bare,
}: StatusIconProps) {
  const { iconPath, iconValue, iconFileName } = resolveStatusIconSource(statusId, icon)
  const resolved = useEntityIcon({
    workspaceId,
    entityType: 'status',
    identifier: statusId,
    iconPath,
    iconDir: '.craft-agent/statuses/icons',
    iconValue,
    // Status icons use {statusId}.ext naming (not icon.ext)
    iconFileName,
  })

  return (
    <EntityIcon
      icon={resolved}
      size={size}
      fallbackIcon={Circle}
      className={className}
      chromeless={chromeless}
      bare={bare}
    />
  )
}
