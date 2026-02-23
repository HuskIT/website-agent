import { z } from 'zod';
import type { BusinessProfile, V2RuntimeMemoryScope, V2RuntimeState } from '~/types/project';

const runtimeMemoryScopeSchema = z.object({
  enabled: z.boolean(),
  resource_id: z.string().optional(),
  thread_id: z.string().optional(),
});

const runtimeStateSchema = z.object({
  provider: z.literal('e2b'),
  sandbox_id: z.string().optional(),
  workspace_id: z.string().optional(),
  session_id: z.string().optional(),
  preview_url: z.string().nullable().optional(),
  lifecycle: z.enum(['running', 'completed', 'failed']),
  workspace_reused: z.boolean().optional(),
  build_attempts: z.number().int().nonnegative().optional(),
  warnings: z.array(z.string()).optional(),
  memory: runtimeMemoryScopeSchema.optional(),
  updated_at: z.string(),
});

export interface BuildRuntimeStateInput {
  sandboxId?: string;
  workspaceId?: string;
  sessionId?: string;
  previewUrl?: string | null;
  lifecycle: V2RuntimeState['lifecycle'];
  workspaceReused?: boolean;
  buildAttempts?: number;
  warnings?: string[];
  memory?: V2RuntimeMemoryScope;
  updatedAt?: string;
}

export function readV2RuntimeState(profile?: BusinessProfile | null): V2RuntimeState | undefined {
  const rawValue = profile?.v2_runtime;

  if (!rawValue) {
    return undefined;
  }

  const parsed = runtimeStateSchema.safeParse(rawValue);

  if (!parsed.success) {
    return undefined;
  }

  return parsed.data as V2RuntimeState;
}

export function buildV2RuntimeState(input: BuildRuntimeStateInput): V2RuntimeState {
  return {
    provider: 'e2b',
    sandbox_id: input.sandboxId,
    workspace_id: input.workspaceId,
    session_id: input.sessionId,
    preview_url: input.previewUrl,
    lifecycle: input.lifecycle,
    workspace_reused: input.workspaceReused,
    build_attempts: input.buildAttempts,
    warnings: input.warnings,
    memory: input.memory,
    updated_at: input.updatedAt ?? new Date().toISOString(),
  };
}

export function mergeBusinessProfileRuntime(
  profile: BusinessProfile | null | undefined,
  runtimeState: V2RuntimeState,
): BusinessProfile {
  return {
    ...(profile ?? {}),
    v2_runtime: runtimeState,
  };
}
