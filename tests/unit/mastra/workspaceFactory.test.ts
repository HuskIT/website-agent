import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildV2E2BSandboxOptions,
  createV2WorkspaceRuntime,
  resolveV2E2BApiKey,
} from '~/lib/mastra/runtime/workspaceFactory.server';

describe('mastra workspaceFactory', () => {
  const originalEnv = {
    E2B_API_KEY: process.env.E2B_API_KEY,
    E2B_API_TOKEN: process.env.E2B_API_TOKEN,
    E2B_ACCESS_TOKEN: process.env.E2B_ACCESS_TOKEN,
  };

  afterEach(() => {
    process.env.E2B_API_KEY = originalEnv.E2B_API_KEY;
    process.env.E2B_API_TOKEN = originalEnv.E2B_API_TOKEN;
    process.env.E2B_ACCESS_TOKEN = originalEnv.E2B_ACCESS_TOKEN;
  });

  it('resolves explicit API key before environment keys', () => {
    process.env.E2B_API_KEY = 'env-key';

    const resolved = resolveV2E2BApiKey('explicit-key');

    expect(resolved).toBe('explicit-key');
  });

  it('builds sandbox options with default workflow metadata', () => {
    const options = buildV2E2BSandboxOptions(
      {
        projectId: 'project-1',
        sandboxTimeoutMs: 12345,
        sandboxMetadata: { branch: 'codex/v2' },
      },
      'test-key',
    );

    expect(options.id).toBe('v2-project-1');
    expect(options.apiKey).toBe('test-key');
    expect(options.timeout).toBe(12345);
    expect(options.metadata).toEqual({
      projectId: 'project-1',
      workflow: 'v2-bootstrap',
      branch: 'codex/v2',
    });
  });

  it('throws when no E2B key is available', () => {
    delete process.env.E2B_API_KEY;
    delete process.env.E2B_API_TOKEN;
    delete process.env.E2B_ACCESS_TOKEN;

    expect(() => createV2WorkspaceRuntime({ projectId: 'project-1' }, {})).toThrow('Missing E2B API key');
  });

  it('uses dependency injection to create sandbox and workspace runtime', () => {
    const fakeSandbox = { id: 'sandbox-1' } as any;
    const fakeWorkspace = { init: vi.fn(), destroy: vi.fn() } as any;
    const createSandbox = vi.fn(() => fakeSandbox);
    const createWorkspace = vi.fn(() => fakeWorkspace);

    const runtime = createV2WorkspaceRuntime(
      {
        projectId: 'project-1',
        apiKey: 'test-key',
      },
      {
        createSandbox,
        createWorkspace,
      },
    );

    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'v2-project-1',
        apiKey: 'test-key',
      }),
    );
    expect(createWorkspace).toHaveBeenCalledWith({
      id: 'v2-project-1',
      name: 'v2-bootstrap-project-1',
      sandbox: fakeSandbox,
    });
    expect(runtime.workspace).toBe(fakeWorkspace);
    expect(runtime.sandbox).toBe(fakeSandbox);
  });
});
