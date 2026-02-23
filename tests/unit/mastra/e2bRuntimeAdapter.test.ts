import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  E2BRuntimeAdapter,
  normalizeSandboxPath,
} from '~/lib/mastra/runtime/e2bRuntimeAdapter.server';

function createMockRuntime() {
  const writeFile = vi.fn(async () => undefined);
  const executeCommand = vi.fn(async () => ({
    success: true,
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    executionTimeMs: 5,
    command: 'node',
    args: ['--version'],
  }));
  const workspace = {
    init: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  } as any;
  const sandbox = {
    id: 'sandbox-123',
    executeCommand,
    instance: {
      files: { write: writeFile },
      getHost: (port: number) => `https://sandbox-123-${port}.example.com`,
    },
  } as any;

  return {
    workspace,
    sandbox,
    filesystemPath: '/tmp/huskit-v2-workspaces/project-1/v2-project-1',
    writeFile,
    executeCommand,
  };
}

describe('mastra e2bRuntimeAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a runtime session and initializes workspace', async () => {
    const runtime = createMockRuntime();
    const workspaceFactory = vi.fn(() => ({
      workspace: runtime.workspace,
      sandbox: runtime.sandbox,
      filesystemPath: runtime.filesystemPath,
    }));
    const createTools = vi.fn(() => ({}));
    const adapter = new E2BRuntimeAdapter(workspaceFactory, createTools);

    const session = await adapter.createSession({
      projectId: 'project-1',
      apiKey: 'test-key',
    });

    expect(runtime.workspace.init).toHaveBeenCalledTimes(1);
    expect(session.sessionId).toBe('sandbox-123');
    expect(session.projectId).toBe('project-1');
    expect(workspaceFactory).toHaveBeenCalledWith({
      projectId: 'project-1',
      apiKey: 'test-key',
    });
    expect(createTools).toHaveBeenCalledTimes(1);
    expect(session.tools).toEqual({});
    expect(session.filesystemPath).toBeDefined();
  });

  it('writes files with normalized sandbox paths when write tool is unavailable', async () => {
    const runtime = createMockRuntime();
    const adapter = new E2BRuntimeAdapter(
      () => ({
        workspace: runtime.workspace,
        sandbox: runtime.sandbox,
        filesystemPath: runtime.filesystemPath,
      }),
      () => ({}),
    );
    const session = await adapter.createSession({
      projectId: 'project-1',
      apiKey: 'test-key',
    });

    const result = await adapter.writeFiles(session, [
      { path: 'src/data/content.ts', content: 'export const content = {};' },
      { path: '/home/user/README.md', content: '# Demo' },
    ]);

    expect(result.written).toBe(2);
    expect(runtime.writeFile).toHaveBeenNthCalledWith(
      1,
      '/home/project/src/data/content.ts',
      'export const content = {};',
    );
    expect(runtime.writeFile).toHaveBeenNthCalledWith(2, '/home/user/README.md', '# Demo');
  });

  it('uses workspace write tool when available', async () => {
    const runtime = createMockRuntime();
    const writeToolExecute = vi.fn(async () => 'ok');
    const adapter = new E2BRuntimeAdapter(
      () => ({
        workspace: runtime.workspace,
        sandbox: runtime.sandbox,
        filesystemPath: runtime.filesystemPath,
      }),
      () => ({
        [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
          execute: writeToolExecute,
        },
      }),
    );
    const session = await adapter.createSession({
      projectId: 'project-1',
      apiKey: 'test-key',
    });

    await adapter.writeFiles(session, [{ path: 'src/data/content.ts', content: 'export const content = {};' }]);

    expect(writeToolExecute).toHaveBeenCalledWith(
      {
        path: '/home/project/src/data/content.ts',
        content: 'export const content = {};',
        overwrite: true,
      },
      { workspace: runtime.workspace },
    );
    expect(runtime.writeFile).toHaveBeenCalledWith('/home/project/src/data/content.ts', 'export const content = {};');
  });

  it('executes commands through workspace execute tool when available', async () => {
    const runtime = createMockRuntime();
    const executeTool = vi.fn(async (_input, context: any) => {
      await context?.writer?.custom({
        type: 'data-sandbox-stdout',
        data: { output: 'install ok\n' },
      });
      await context?.writer?.custom({
        type: 'data-sandbox-exit',
        data: { exitCode: 0, success: true, executionTimeMs: 11 },
      });

      return 'install ok';
    });
    const adapter = new E2BRuntimeAdapter(
      () => ({
        workspace: runtime.workspace,
        sandbox: runtime.sandbox,
        filesystemPath: runtime.filesystemPath,
      }),
      () => ({
        [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
          execute: executeTool,
        },
      }),
    );
    const session = await adapter.createSession({
      projectId: 'project-1',
      apiKey: 'test-key',
    });

    const commandResult = await adapter.runCommand(session, 'npm', ['install'], {
      cwd: '/home/user',
      timeout: 30_000,
    });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(commandResult.exitCode).toBe(0);
    expect(commandResult.success).toBe(true);
    expect(commandResult.stdout).toContain('install ok');
    expect(runtime.executeCommand).not.toHaveBeenCalled();
  });

  it('falls back to sandbox command execution when env override is provided', async () => {
    const runtime = createMockRuntime();
    const executeTool = vi.fn(async () => 'unused');
    const adapter = new E2BRuntimeAdapter(
      () => ({
        workspace: runtime.workspace,
        sandbox: runtime.sandbox,
        filesystemPath: runtime.filesystemPath,
      }),
      () => ({
        [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
          execute: executeTool,
        },
      }),
    );
    const session = await adapter.createSession({
      projectId: 'project-1',
      apiKey: 'test-key',
    });

    const commandResult = await adapter.runCommand(session, 'npm', ['install'], {
      cwd: '/home/project',
      timeout: 30_000,
      env: { NODE_ENV: 'production' },
    });

    expect(runtime.executeCommand).toHaveBeenCalledWith('npm', ['install'], {
      cwd: '/home/project',
      timeout: 30_000,
      env: { NODE_ENV: 'production' },
    });
    expect(commandResult.exitCode).toBe(0);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('starts preview command and resolves preview URL', async () => {
    const runtime = createMockRuntime();
    runtime.executeCommand.mockResolvedValueOnce({
      success: true,
      exitCode: 0,
      stdout: '4321\n',
      stderr: '',
      executionTimeMs: 4,
      command: 'bash',
      args: ['-lc', 'noop'],
    });
    const adapter = new E2BRuntimeAdapter(
      () => ({
        workspace: runtime.workspace,
        sandbox: runtime.sandbox,
        filesystemPath: runtime.filesystemPath,
      }),
      () => ({}),
    );
    const session = await adapter.createSession({
      projectId: 'project-1',
      apiKey: 'test-key',
    });

    const preview = await adapter.startPreview(session, { port: 4173 });

    expect(runtime.executeCommand).toHaveBeenCalledWith(
      'bash',
      expect.arrayContaining(['-lc', expect.stringContaining('nohup npm run dev -- --host 0.0.0.0 --port 4173')]),
      {
        cwd: '/home/project',
      },
    );
    expect(preview.url).toBe('https://sandbox-123-4173.example.com');
    expect(preview.pid).toBe(4321);
  });

  it('cleans up workspace resources', async () => {
    const runtime = createMockRuntime();
    const adapter = new E2BRuntimeAdapter(
      () => ({
        workspace: runtime.workspace,
        sandbox: runtime.sandbox,
        filesystemPath: runtime.filesystemPath,
      }),
      () => ({}),
    );
    const session = await adapter.createSession({
      projectId: 'project-1',
      apiKey: 'test-key',
    });

    await adapter.cleanup(session);

    expect(runtime.workspace.destroy).toHaveBeenCalledTimes(1);
  });

  it('normalizes sandbox file paths and blocks parent traversal', () => {
    expect(normalizeSandboxPath('src/main.ts')).toBe('/home/project/src/main.ts');
    expect(normalizeSandboxPath('/home/project/app.ts')).toBe('/home/project/app.ts');
    expect(() => normalizeSandboxPath('../secrets.txt')).toThrow('Parent directory traversal is not allowed');
  });
});
