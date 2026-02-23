import os from 'node:os';
import path from 'node:path';
import { LocalFilesystem, Workspace, WORKSPACE_TOOLS, type WorkspaceToolsConfig } from '@mastra/core/workspace';
import { E2BSandbox, type E2BSandboxOptions } from '@mastra/e2b';

const DEFAULT_SANDBOX_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_WORKFLOW_TAG = 'v2-bootstrap';
const DEFAULT_LOCAL_WORKSPACE_ROOT = path.join(os.tmpdir(), 'huskit-v2-workspaces');

export interface V2WorkspaceFactoryInput {
  projectId: string;
  apiKey?: string;
  sandboxId?: string;
  workspaceId?: string;
  workspaceName?: string;
  localWorkspaceRoot?: string;
  sandboxTimeoutMs?: number;
  sandboxEnv?: Record<string, string>;
  sandboxMetadata?: Record<string, unknown>;
  toolsConfig?: WorkspaceToolsConfig;
}

export interface V2WorkspaceRuntime {
  workspace: Workspace<any, E2BSandbox>;
  sandbox: E2BSandbox;
  filesystemPath: string;
}

interface WorkspaceFactoryDependencies {
  createSandbox?: (options: E2BSandboxOptions) => E2BSandbox;
  createWorkspace?: (config: {
    id: string;
    name: string;
    filesystem: LocalFilesystem;
    sandbox: E2BSandbox;
    tools: WorkspaceToolsConfig;
  }) => Workspace<any, E2BSandbox>;
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

export function buildV2WorkspaceToolsConfig(overrides?: WorkspaceToolsConfig): WorkspaceToolsConfig {
  return {
    enabled: true,
    requireApproval: false,
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
      enabled: false,
    },
    ...(overrides ?? {}),
  };
}

export function resolveV2LocalWorkspaceRoot(explicitRoot?: string): string {
  const configuredRoot = explicitRoot || process.env.V2_LOCAL_WORKSPACE_ROOT;

  return configuredRoot || DEFAULT_LOCAL_WORKSPACE_ROOT;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]/g, '_');

  return sanitized || 'workspace';
}

export function buildV2LocalWorkspacePath(input: V2WorkspaceFactoryInput): string {
  const root = resolveV2LocalWorkspaceRoot(input.localWorkspaceRoot);
  const projectSegment = sanitizePathSegment(input.projectId);
  const workspaceSegment = sanitizePathSegment(input.workspaceId ?? `v2-${projectSegment}`);

  return path.join(root, projectSegment, workspaceSegment);
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
  const filesystemPath = buildV2LocalWorkspacePath({
    ...input,
    projectId,
    workspaceId,
  });
  const filesystem = new LocalFilesystem({
    basePath: filesystemPath,
    contained: true,
    readOnly: false,
  });
  const tools = buildV2WorkspaceToolsConfig(input.toolsConfig);
  const workspace = deps.createWorkspace
    ? deps.createWorkspace({
        id: workspaceId,
        name: workspaceName,
        filesystem,
        sandbox,
        tools,
      })
    : new Workspace({
        id: workspaceId,
        name: workspaceName,
        filesystem,
        sandbox,
        tools,
      });

  return {
    workspace,
    sandbox,
    filesystemPath,
  };
}
