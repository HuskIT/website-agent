/**
 * Sandbox Settings Tab
 * Feature: 001-sandbox-providers
 *
 * MVP: Read-only status display. Provider is set via SANDBOX_PROVIDER_DEFAULT env var.
 * No user selection - this simplifies the MVP and ensures consistent behavior.
 */

import { useStore } from '@nanostores/react';
import { classNames } from '~/utils/classNames';
import { workbenchStore } from '~/lib/stores/workbench';
import { sandboxState } from '~/lib/stores/sandbox';
import type { SandboxProviderType } from '~/lib/sandbox/types';

interface ProviderStatus {
  id: SandboxProviderType;
  name: string;
  description: string;
  status: 'active' | 'inactive';
}

export default function SandboxTab() {
  const currentProvider = workbenchStore.currentProviderType;
  const sandboxStatus = useStore(sandboxState).status;

  const providerStatus: ProviderStatus = {
    id: currentProvider,
    name: currentProvider === 'vercel' ? 'Vercel Sandbox (Cloud)' : 'WebContainer (Local)',
    description:
      currentProvider === 'vercel'
        ? "Running on Vercel's cloud infrastructure with persistent sessions."
        : 'Running entirely in your browser using WebContainer technology.',
    status: sandboxStatus === 'connected' ? 'active' : 'inactive',
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-bolt-elements-textPrimary">Sandbox Status</h2>
        <p className="text-sm text-bolt-elements-textSecondary">
          Current code execution environment. Provider is configured by the administrator.
        </p>
      </div>

      {/* Current Provider Card */}
      <div
        className={classNames(
          'rounded-xl border-2 p-4',
          providerStatus.status === 'active'
            ? 'border-green-500/30 bg-green-500/5'
            : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2',
        )}
      >
        <div className="flex items-start gap-4">
          {/* Status Icon */}
          <div
            className={classNames(
              'w-10 h-10 rounded-lg flex items-center justify-center',
              providerStatus.status === 'active' ? 'bg-green-500/10' : 'bg-bolt-elements-background-depth-3',
            )}
          >
            {currentProvider === 'vercel' ? (
              <div className="i-ph:cloud text-blue-500 w-5 h-5" />
            ) : (
              <div className="i-ph:desktop text-green-500 w-5 h-5" />
            )}
          </div>

          {/* Content */}
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-bolt-elements-textPrimary">{providerStatus.name}</h3>
              {providerStatus.status === 'active' && (
                <span className="px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 text-xs font-medium">
                  Active
                </span>
              )}
            </div>
            <p className="text-sm text-bolt-elements-textSecondary mt-1">{providerStatus.description}</p>

            {/* Details */}
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <div
                  className={classNames(
                    'w-2 h-2 rounded-full',
                    sandboxStatus === 'connected'
                      ? 'bg-green-500'
                      : sandboxStatus === 'connecting'
                        ? 'bg-yellow-500 animate-pulse'
                        : sandboxStatus === 'error'
                          ? 'bg-red-500'
                          : 'bg-gray-400',
                  )}
                />
                <span className="text-bolt-elements-textSecondary">
                  Status: <span className="text-bolt-elements-textPrimary capitalize">{sandboxStatus}</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Info Box */}
      <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 p-4">
        <div className="flex items-start gap-3">
          <div className="i-ph:info text-blue-500 w-5 h-5 mt-0.5 flex-shrink-0" />
          <div className="space-y-1">
            <h4 className="font-medium text-blue-700 dark:text-blue-400">Admin Configuration</h4>
            <p className="text-sm text-blue-600 dark:text-blue-300">
              The sandbox provider is set via the{' '}
              <code className="bg-blue-500/20 px-1 rounded">SANDBOX_PROVIDER_DEFAULT</code> environment variable.
              Current value: <code className="bg-blue-500/20 px-1 rounded">{currentProvider}</code>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
