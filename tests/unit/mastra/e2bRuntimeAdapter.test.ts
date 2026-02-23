import { describe, expect, it, vi } from 'vitest';
import {
  E2BRuntimeAdapter,
  normalizeSandboxPath,
  type V2RuntimeSession,
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
  const commandsRun = vi.fn(async () => ({ pid: 4321 }));
  const workspace = {
    init: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  } as any;
  const sandbox = {
    id: 'sandbox-123',
    executeCommand,
    instance: {
      files: { write: writeFile },
      commands: { run: commandsRun },
      getHost: (port: number) => `https://sandbox-123-${port}.example.com`,
    },
  } as any;

  return {
    workspace,
    sandbox,
    writeFile,
    executeCommand,
    commandsRun,
  };
}

describe('mastra e2bRuntimeAdapter', () => {
  it('creates a runtime session and initializes workspace', async () => {
    const runtime = createMockRuntime();
    const workspaceFactory = vi.fn(() => ({
      workspace: runtime.workspace,
      sandbox: runtime.sandbox,
    }));
    const adapter = new E2BRuntimeAdapter(workspaceFactory);

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
  });

  it('writes files with normalized sandbox paths', async () => {
    const runtime = createMockRuntime();
    const adapter = new E2BRuntimeAdapter(() => ({
      workspace: runtime.workspace,
      sandbox: runtime.sandbox,
    }));
    const session = (await adapter.createSession({
      projectId: 'project-1',
      apiKey: 'test-key',
    })) as V2RuntimeSession;

    const result = await adapter.writeFiles(session, [
      { path: 'src/data/content.ts', content: 'export const content = {};' },
      { path: '/home/user/README.md', content: '# Demo' },
    ]);

    expect(result.written).toBe(2);
    expect(runtime.writeFile).toHaveBeenNthCalledWith(
      1,
      '/home/user/src/data/content.ts',
      'export const content = {};',
    );
    expect(runtime.writeFile).toHaveBeenNthCalledWith(2, '/home/user/README.md', '# Demo');
  });

  it('executes commands in sandbox', async () => {
    const runtime = createMockRuntime();
    const adapter = new E2BRuntimeAdapter(() => ({
      workspace: runtime.workspace,
      sandbox: runtime.sandbox,
    }));
    const session = await adapter.createSession({
      projectId: 'project-1',
      apiKey: 'test-key',
    });

    const commandResult = await adapter.runCommand(session, 'npm', ['install'], {
      cwd: '/home/user',
      timeout: 30_000,
    });

    expect(runtime.executeCommand).toHaveBeenCalledWith('npm', ['install'], {
      cwd: '/home/user',
      timeout: 30_000,
    });
    expect(commandResult.exitCode).toBe(0);
  });

  it('starts preview command and resolves preview URL', async () => {
    const runtime = createMockRuntime();
    const adapter = new E2BRuntimeAdapter(() => ({
      workspace: runtime.workspace,
      sandbox: runtime.sandbox,
    }));
    const session = await adapter.createSession({
      projectId: 'project-1',
      apiKey: 'test-key',
    });

    const preview = await adapter.startPreview(session, { port: 4173 });

    expect(runtime.commandsRun).toHaveBeenCalledWith('npm run dev -- --host 0.0.0.0 --port 4173', {
      background: true,
      cwd: '/home/user',
      envs: undefined,
    });
    expect(preview.url).toBe('https://sandbox-123-4173.example.com');
    expect(preview.pid).toBe(4321);
  });

  it('cleans up workspace resources', async () => {
    const runtime = createMockRuntime();
    const adapter = new E2BRuntimeAdapter(() => ({
      workspace: runtime.workspace,
      sandbox: runtime.sandbox,
    }));
    const session = await adapter.createSession({
      projectId: 'project-1',
      apiKey: 'test-key',
    });

    await adapter.cleanup(session);

    expect(runtime.workspace.destroy).toHaveBeenCalledTimes(1);
  });

  it('normalizes sandbox file paths and blocks parent traversal', () => {
    expect(normalizeSandboxPath('src/main.ts')).toBe('/home/user/src/main.ts');
    expect(normalizeSandboxPath('/home/user/app.ts')).toBe('/home/user/app.ts');
    expect(() => normalizeSandboxPath('../secrets.txt')).toThrow('Parent directory traversal is not allowed');
  });
});
