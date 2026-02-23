import {
  WORKSPACE_TOOLS,
  createWorkspaceTools,
  type CommandResult,
  type ExecuteCommandOptions,
} from '@mastra/core/workspace';
import {
  createV2WorkspaceRuntime,
  type V2WorkspaceFactoryInput,
  type V2WorkspaceRuntime,
} from '~/lib/mastra/runtime/workspaceFactory.server';

const DEFAULT_SANDBOX_WORKDIR = '/home/project';
const DEFAULT_PREVIEW_PORT = 4173;
const DEFAULT_PREVIEW_LOG_DIR = '/tmp';
const DEFAULT_PREVIEW_READINESS_TIMEOUT_MS = 45_000;
const DEFAULT_PREVIEW_READINESS_POLL_MS = 1_000;

interface WorkspaceToolEvent {
  type?: string;
  data?: {
    output?: string;
    exitCode?: number;
    success?: boolean;
    executionTimeMs?: number;
  };
}

interface WorkspaceToolLike {
  execute?: (
    inputData: unknown,
    context?: { workspace?: V2RuntimeSession['workspace']; writer?: unknown },
  ) => Promise<unknown>;
}

type WorkspaceToolMap = Record<string, WorkspaceToolLike>;
type WorkspaceRuntimeFactory = (input: V2WorkspaceFactoryInput) => V2WorkspaceRuntime;
type WorkspaceToolFactory = (workspace: V2WorkspaceRuntime['workspace']) => WorkspaceToolMap;

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
  filesystemPath: V2WorkspaceRuntime['filesystemPath'];
  tools: WorkspaceToolMap;
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

function quoteShell(input: string): string {
  return `'${input.replace(/'/g, `'\"'\"'`)}'`;
}

function toShellEnvPrefix(envs?: Record<string, string>): string {
  if (!envs) {
    return '';
  }

  const entries = Object.entries(envs).filter(([key]) => key.trim().length > 0);

  if (entries.length === 0) {
    return '';
  }

  return entries.map(([key, value]) => `${key}=${quoteShell(value)}`).join(' ');
}

function parseExitCodeFromOutput(output: string): number | null {
  const match = output.match(/Exit code:\s*(-?\d+)/i);

  if (!match) {
    return null;
  }

  return Number.parseInt(match[1], 10);
}

function parsePreviewPid(output: string): number | undefined {
  const match = output.match(/^\s*(\d+)\s*$/m);

  if (!match) {
    return undefined;
  }

  const parsed = Number.parseInt(match[1], 10);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function toHttpUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();

  if (!trimmed) {
    throw new Error('Preview URL is empty');
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

async function waitForPreviewReadiness(
  url: string,
  timeoutMs: number = DEFAULT_PREVIEW_READINESS_TIMEOUT_MS,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, {
        method: 'GET',
      });

      // Consider any HTTP response as reachable (app may return non-200 routes while booting).
      if (response.status > 0) {
        return;
      }
    } catch {
      // Retry until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, DEFAULT_PREVIEW_READINESS_POLL_MS));
  }

  throw new Error(`Preview URL did not become reachable within ${timeoutMs}ms`);
}

function toOutputString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

export class E2BRuntimeAdapter implements BootstrapRuntimeAdapter {
  constructor(
    private readonly createWorkspaceRuntime: WorkspaceRuntimeFactory = createV2WorkspaceRuntime,
    private readonly createWorkspaceToolsMap: WorkspaceToolFactory = (workspace) => createWorkspaceTools(workspace),
  ) {}

  private getWorkspaceTool(session: V2RuntimeSession, toolName: string): WorkspaceToolLike | null {
    const tool = session.tools[toolName];

    if (!tool?.execute) {
      return null;
    }

    return tool;
  }

  async createSession(input: V2WorkspaceFactoryInput): Promise<V2RuntimeSession> {
    const runtime = this.createWorkspaceRuntime(input);
    await runtime.workspace.init();

    const sessionId = resolveSessionId(runtime);
    const tools = this.createWorkspaceToolsMap(runtime.workspace);

    return {
      sessionId,
      projectId: input.projectId,
      createdAt: new Date().toISOString(),
      workspace: runtime.workspace,
      sandbox: runtime.sandbox,
      filesystemPath: runtime.filesystemPath,
      tools,
    };
  }

  async writeFiles(session: V2RuntimeSession, files: RuntimeFilePayload[]): Promise<{ written: number }> {
    let written = 0;
    const writeTool = this.getWorkspaceTool(session, WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE);
    const readTool = this.getWorkspaceTool(session, WORKSPACE_TOOLS.FILESYSTEM.READ_FILE);

    for (const file of files) {
      const targetPath = normalizeSandboxPath(file.path);

      if (writeTool?.execute) {
        if (readTool?.execute) {
          await readTool
            .execute(
              {
                path: targetPath,
              },
              {
                workspace: session.workspace,
              },
            )
            .catch(() => undefined);
        }

        await writeTool.execute(
          {
            path: targetPath,
            content: file.content,
            overwrite: true,
          },
          {
            workspace: session.workspace,
          },
        );
      }

      // Keep sandbox project files in sync with workspace file writes.
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
    const executeTool = this.getWorkspaceTool(session, WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND);

    if (!executeTool?.execute || options?.env) {
      return session.sandbox.executeCommand(command, args, options);
    }

    let streamedStdout = '';
    let streamedStderr = '';
    let toolExitCode: number | null = null;
    let toolSuccess: boolean | null = null;
    let toolExecutionTimeMs: number | null = null;
    const startedAt = Date.now();
    const toolOutput = await executeTool.execute(
      {
        command,
        args,
        cwd: options?.cwd ?? null,
        timeout: options?.timeout ?? null,
      },
      {
        workspace: session.workspace,
        writer: {
          custom: async (event: WorkspaceToolEvent) => {
            if (event.type === 'data-sandbox-stdout' && typeof event.data?.output === 'string') {
              streamedStdout += event.data.output;
            }

            if (event.type === 'data-sandbox-stderr' && typeof event.data?.output === 'string') {
              streamedStderr += event.data.output;
            }

            if (event.type === 'data-sandbox-exit') {
              if (typeof event.data?.exitCode === 'number') {
                toolExitCode = event.data.exitCode;
              }

              if (typeof event.data?.success === 'boolean') {
                toolSuccess = event.data.success;
              }

              if (typeof event.data?.executionTimeMs === 'number') {
                toolExecutionTimeMs = event.data.executionTimeMs;
              }
            }
          },
        },
      },
    );

    const outputText = toOutputString(toolOutput);
    const parsedExitCode = parseExitCodeFromOutput(outputText);
    const exitCode = toolExitCode ?? parsedExitCode ?? (outputText.toLowerCase().includes('error:') ? 1 : 0);
    const success = toolSuccess ?? exitCode === 0;
    const executionTimeMs = toolExecutionTimeMs ?? Date.now() - startedAt;
    let stdout = streamedStdout.trim().length > 0 ? streamedStdout : '';
    let stderr = streamedStderr.trim().length > 0 ? streamedStderr : '';

    if (!stdout && !stderr && outputText.trim()) {
      if (success) {
        stdout = outputText;
      } else {
        stderr = outputText;
      }
    } else if (!success && outputText.trim() && !stderr.includes(outputText)) {
      stderr = stderr ? `${stderr}\n${outputText}` : outputText;
    }

    return {
      command,
      args,
      stdout,
      stderr,
      exitCode,
      success,
      executionTimeMs,
    };
  }

  getPreviewUrl(session: V2RuntimeSession, port: number = DEFAULT_PREVIEW_PORT): string {
    const hostGetter = session.sandbox.instance?.getHost;

    if (typeof hostGetter === 'function') {
      return toHttpUrl(hostGetter.call(session.sandbox.instance, port));
    }

    const domainGetter = (session.sandbox.instance as { domain?: (value: number) => string }).domain;

    if (typeof domainGetter === 'function') {
      return toHttpUrl(domainGetter.call(session.sandbox.instance, port));
    }

    throw new Error('E2B sandbox instance does not expose getHost()/domain() for preview URL resolution');
  }

  async startPreview(session: V2RuntimeSession, input: RuntimePreviewInput = {}): Promise<RuntimePreviewResult> {
    const port = input.port ?? DEFAULT_PREVIEW_PORT;
    const cwd = input.cwd ?? DEFAULT_SANDBOX_WORKDIR;
    const command = input.command ?? `npm run dev -- --host 0.0.0.0 --port ${port}`;
    const previewLogPath = `${DEFAULT_PREVIEW_LOG_DIR}/v2-preview-${session.sessionId}-${port}.log`;
    const envPrefix = toShellEnvPrefix(input.envs);
    const launchCommand = `${envPrefix ? `${envPrefix} ` : ''}nohup ${command} > ${quoteShell(previewLogPath)} 2>&1 & echo $!`;
    const result = await this.runCommand(session, 'bash', ['-lc', launchCommand], { cwd });

    if (result.exitCode !== 0 || result.success === false) {
      const details = result.stderr || result.stdout || 'unknown preview startup failure';
      throw new Error(`Failed to start preview server: ${details}`);
    }

    const previewUrl = this.getPreviewUrl(session, port);

    try {
      await waitForPreviewReadiness(previewUrl);
    } catch (error) {
      const logResult = await this.runCommand(session, 'bash', ['-lc', `tail -n 120 ${quoteShell(previewLogPath)}`], {
        cwd,
      }).catch(() => null);
      const logSnippet = logResult?.stdout || logResult?.stderr || '';

      throw new Error(
        `Preview failed readiness check (${previewUrl}): ${error instanceof Error ? error.message : 'unknown error'}${logSnippet ? `\n${logSnippet}` : ''}`,
      );
    }

    return {
      port,
      url: previewUrl,
      command,
      pid: parsePreviewPid(result.stdout),
    };
  }

  async cleanup(session: V2RuntimeSession): Promise<void> {
    await session.workspace.destroy();
  }
}
