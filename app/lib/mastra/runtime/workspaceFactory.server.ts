import { Workspace } from '@mastra/core/workspace';
import { E2BSandbox, type E2BSandboxOptions } from '@mastra/e2b';

const DEFAULT_SANDBOX_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_WORKFLOW_TAG = 'v2-bootstrap';

export interface V2WorkspaceFactoryInput {
  projectId: string;
  apiKey?: string;
  sandboxId?: string;
  workspaceId?: string;
  workspaceName?: string;
  sandboxTimeoutMs?: number;
  sandboxEnv?: Record<string, string>;
  sandboxMetadata?: Record<string, unknown>;
}

export interface V2WorkspaceRuntime {
  workspace: Workspace<any, E2BSandbox>;
  sandbox: E2BSandbox;
}

interface WorkspaceFactoryDependencies {
  createSandbox?: (options: E2BSandboxOptions) => E2BSandbox;
  createWorkspace?: (config: { id: string; name: string; sandbox: E2BSandbox }) => Workspace<any, E2BSandbox>;
}

export function resolveV2E2BApiKey(explicitApiKey?: string): string | undefined {
  return explicitApiKey || process.env.E2B_API_KEY || process.env.E2B_API_TOKEN || process.env.E2B_ACCESS_TOKEN;
}

export function buildV2E2BSandboxOptions(input: V2WorkspaceFactoryInput, apiKey: string): E2BSandboxOptions {
  return {
    id: input.sandboxId ?? `v2-${input.projectId}`,
    apiKey,
    timeout: input.sandboxTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
    env: input.sandboxEnv,
    metadata: {
      projectId: input.projectId,
      workflow: DEFAULT_WORKFLOW_TAG,
      ...(input.sandboxMetadata ?? {}),
    },
  };
}

export function createV2WorkspaceRuntime(
  input: V2WorkspaceFactoryInput,
  deps: WorkspaceFactoryDependencies = {},
): V2WorkspaceRuntime {
  const projectId = input.projectId?.trim();

  if (!projectId) {
    throw new Error('projectId is required to create V2 workspace runtime');
  }

  const apiKey = resolveV2E2BApiKey(input.apiKey);

  if (!apiKey) {
    throw new Error('Missing E2B API key (set E2B_API_KEY, E2B_API_TOKEN, or E2B_ACCESS_TOKEN)');
  }

  const sandboxOptions = buildV2E2BSandboxOptions(
    {
      ...input,
      projectId,
    },
    apiKey,
  );

  const sandbox = deps.createSandbox ? deps.createSandbox(sandboxOptions) : new E2BSandbox(sandboxOptions);
  const workspaceId = input.workspaceId ?? `v2-${projectId}`;
  const workspaceName = input.workspaceName ?? `v2-bootstrap-${projectId}`;
  const workspace = deps.createWorkspace
    ? deps.createWorkspace({
        id: workspaceId,
        name: workspaceName,
        sandbox,
      })
    : new Workspace({
        id: workspaceId,
        name: workspaceName,
        sandbox,
      });

  return {
    workspace,
    sandbox,
  };
}
