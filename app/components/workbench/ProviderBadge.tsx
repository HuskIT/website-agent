/**
 * Provider Badge Component
 * Feature: 001-sandbox-providers
 *
 * Displays the current sandbox provider status in the workbench header.
 * For MVP: Read-only indicator, no user switching.
 * Provider is set via SANDBOX_PROVIDER_DEFAULT env var.
 */

import { useStore } from '@nanostores/react';
import { classNames } from '~/utils/classNames';
import { workbenchStore } from '~/lib/stores/workbench';
import type { SandboxProviderType } from '~/lib/sandbox/types';

interface ProviderBadgeProps {
  className?: string;
}

const PROVIDER_CONFIG: Record<
  SandboxProviderType,
  { label: string; icon: string; color: string; description: string }
> = {
  webcontainer: {
    label: 'Local',
    icon: 'i-ph:desktop',
    color: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
    description: 'Running in browser (WebContainer)',
  },
  vercel: {
    label: 'Cloud',
    icon: 'i-ph:cloud',
    color: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
    description: 'Running on Vercel Sandbox',
  },
};

export function ProviderBadge({ className }: ProviderBadgeProps) {
  const loadingStatus = useStore(workbenchStore.loadingStatus);
  const currentProvider = workbenchStore.currentProviderType;
  const config = PROVIDER_CONFIG[currentProvider];

  if (loadingStatus) {
    return (
      <div
        className={classNames(
          'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium border animate-pulse',
          'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/30',
          className,
        )}
        title="Initializing sandbox..."
      >
        <div className="i-ph:spinner animate-spin" />
        <span>{loadingStatus}</span>
      </div>
    );
  }

  return (
    <div
      className={classNames(
        'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium border',
        config.color,
        className,
      )}
      title={config.description}
    >
      <div className={config.icon} />
      <span>{config.label}</span>
      {/* <div className="i-ph:caret-down text-[10px] opacity-50 block md:hidden" /> */}
    </div>
  );
}
