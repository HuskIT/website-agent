import type { CommandResult, ExecuteCommandOptions } from '@mastra/core/workspace';
import {
  createV2WorkspaceRuntime,
  type V2WorkspaceFactoryInput,
  type V2WorkspaceRuntime,
} from '~/lib/mastra/runtime/workspaceFactory.server';

const DEFAULT_SANDBOX_WORKDIR = '/home/user';
const DEFAULT_PREVIEW_PORT = 4173;

export interface RuntimeFilePayload {
  path: string;
  content: string;
}

export interface RuntimePreviewInput {
  port?: number;
  cwd?: string;
  command?: string;
  envs?: Record<string, string>;
}

export interface RuntimePreviewResult {
  port: number;
  url: string;
  command: string;
  pid?: number;
}

export interface V2RuntimeSession {
  sessionId: string;
  projectId: string;
  createdAt: string;
  workspace: V2WorkspaceRuntime['workspace'];
  sandbox: V2WorkspaceRuntime['sandbox'];
}

export interface BootstrapRuntimeAdapter {
  createSession: (input: V2WorkspaceFactoryInput) => Promise<V2RuntimeSession>;
  writeFiles: (session: V2RuntimeSession, files: RuntimeFilePayload[]) => Promise<{ written: number }>;
  runCommand: (
    session: V2RuntimeSession,
    command: string,
    args?: string[],
    options?: ExecuteCommandOptions,
  ) => Promise<CommandResult>;
  startPreview: (session: V2RuntimeSession, input?: RuntimePreviewInput) => Promise<RuntimePreviewResult>;
  cleanup: (session: V2RuntimeSession) => Promise<void>;
}

type WorkspaceRuntimeFactory = (input: V2WorkspaceFactoryInput) => V2WorkspaceRuntime;

function resolveSessionId(runtime: V2WorkspaceRuntime): string {
  const sandboxId = runtime.sandbox.id?.trim();

  if (sandboxId) {
    return sandboxId;
  }

  return `runtime-${crypto.randomUUID()}`;
}

export function normalizeSandboxPath(path: string): string {
  const trimmed = path.trim();

  if (!trimmed) {
    throw new Error('File path is required for sandbox writes');
  }

  if (trimmed.includes('..')) {
    throw new Error(`Parent directory traversal is not allowed: "${path}"`);
  }

  if (trimmed.startsWith('/')) {
    return trimmed.replace(/\/+/g, '/');
  }

  return `${DEFAULT_SANDBOX_WORKDIR}/${trimmed}`.replace(/\/+/g, '/');
}

export class E2BRuntimeAdapter implements BootstrapRuntimeAdapter {
  constructor(private readonly createWorkspaceRuntime: WorkspaceRuntimeFactory = createV2WorkspaceRuntime) {}

  async createSession(input: V2WorkspaceFactoryInput): Promise<V2RuntimeSession> {
    const runtime = this.createWorkspaceRuntime(input);
    await runtime.workspace.init();

    const sessionId = resolveSessionId(runtime);

    return {
      sessionId,
      projectId: input.projectId,
      createdAt: new Date().toISOString(),
      workspace: runtime.workspace,
      sandbox: runtime.sandbox,
    };
  }

  async writeFiles(session: V2RuntimeSession, files: RuntimeFilePayload[]): Promise<{ written: number }> {
    let written = 0;

    for (const file of files) {
      const targetPath = normalizeSandboxPath(file.path);
      await session.sandbox.instance.files.write(targetPath, file.content);
      written += 1;
    }

    return { written };
  }

  async runCommand(
    session: V2RuntimeSession,
    command: string,
    args: string[] = [],
    options?: ExecuteCommandOptions,
  ): Promise<CommandResult> {
    return session.sandbox.executeCommand(command, args, options);
  }

  getPreviewUrl(session: V2RuntimeSession, port: number = DEFAULT_PREVIEW_PORT): string {
    const hostGetter = session.sandbox.instance?.getHost;

    if (typeof hostGetter === 'function') {
      return hostGetter.call(session.sandbox.instance, port);
    }

    const domainGetter = (session.sandbox.instance as { domain?: (value: number) => string }).domain;

    if (typeof domainGetter === 'function') {
      return domainGetter.call(session.sandbox.instance, port);
    }

    throw new Error('E2B sandbox instance does not expose getHost()/domain() for preview URL resolution');
  }

  async startPreview(session: V2RuntimeSession, input: RuntimePreviewInput = {}): Promise<RuntimePreviewResult> {
    const port = input.port ?? DEFAULT_PREVIEW_PORT;
    const cwd = input.cwd ?? DEFAULT_SANDBOX_WORKDIR;
    const command = input.command ?? `npm run dev -- --host 0.0.0.0 --port ${port}`;
    const handle = await session.sandbox.instance.commands.run(command, {
      background: true,
      cwd,
      envs: input.envs,
    });

    return {
      port,
      url: this.getPreviewUrl(session, port),
      command,
      pid: typeof handle.pid === 'number' ? handle.pid : undefined,
    };
  }

  async cleanup(session: V2RuntimeSession): Promise<void> {
    await session.workspace.destroy();
  }
}
