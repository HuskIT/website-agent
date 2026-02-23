import { describe, expect, it, vi } from 'vitest';
import type { GeneratedFile } from '~/types/generation';
import type { ProviderInfo } from '~/types/model';
import type { TemplateSelection } from '~/lib/services/projectGenerationService';
import type { BusinessProfile } from '~/types/project';
import {
  createBootstrapWebsiteWorkflow,
  type BootstrapGenerationInput,
  type BootstrapRuntimeInput,
} from '~/lib/mastra/workflows/bootstrapWebsite';
import type { BootstrapRuntimeAdapter, V2RuntimeSession } from '~/lib/mastra/runtime/e2bRuntimeAdapter.server';

function createProvider(name = 'Moonshot'): ProviderInfo {
  return {
    name,
    staticModels: [],
  };
}

function createGenerationInput(): BootstrapGenerationInput {
  return {
    model: 'kimi-for-coding',
    provider: createProvider(),
    baseUrl: 'http://localhost',
    cookieHeader: null,
    apiKeys: {},
    providerSettings: {},
  };
}

function createRuntimeSessionMock(): V2RuntimeSession {
  return {
    sessionId: 'sandbox-session-1',
    projectId: 'project-1',
    createdAt: new Date().toISOString(),
    workspace: {
      init: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
    } as any,
    sandbox: {} as any,
  };
}

function createRuntimeInput(adapter: BootstrapRuntimeAdapter): BootstrapRuntimeInput {
  return {
    workspace: {
      projectId: 'project-1',
      apiKey: 'e2b-test-key',
    },
    adapter,
    buildCwd: '/home/project',
    installCommand: 'pnpm install',
    buildCommand: 'pnpm run build',
    maxBuildAttempts: 2,
    preview: {
      port: 4173,
      command: 'pnpm run dev -- --host 0.0.0.0 --port 4173',
    },
  };
}

function createGeneratedFiles(): GeneratedFile[] {
  return [
    {
      path: '/home/project/src/data/content.ts',
      content: 'export const content = {};',
      size: 26,
    },
    {
      path: '/home/project/README.md',
      content: '# Demo',
      size: 6,
    },
  ];
}

function createGenerateContentMock(files: GeneratedFile[]) {
  return vi.fn(async function* () {
    for (const file of files) {
      yield {
        event: 'file' as const,
        data: file,
      };
    }
  });
}

describe('bootstrapWebsite workflow write_file integration', () => {
  it('executes autonomous stages and returns preview artifact on success', async () => {
    const generatedFiles = createGeneratedFiles();
    const runtimeSession = createRuntimeSessionMock();
    const createSession = vi.fn(async () => runtimeSession);
    const writeFiles = vi.fn(async () => ({ written: 1 }));
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        exitCode: 0,
        stdout: 'installed',
        stderr: '',
        executionTimeMs: 10,
      })
      .mockResolvedValueOnce({
        success: true,
        exitCode: 0,
        stdout: 'build ok',
        stderr: '',
        executionTimeMs: 20,
      });
    const startPreview = vi.fn(async () => ({
      port: 4173,
      url: 'https://sandbox-preview.example.com',
      command: 'pnpm run dev -- --host 0.0.0.0 --port 4173',
      pid: 1234,
    }));
    const cleanup = vi.fn(async () => undefined);
    const runtimeAdapter: BootstrapRuntimeAdapter = {
      createSession,
      writeFiles,
      runCommand,
      startPreview,
      cleanup,
    };
    const selectTemplate: (
      businessProfile: BusinessProfile,
      fastModel: string,
      provider: ProviderInfo,
      baseUrl: string,
      cookieHeader: string | null,
    ) => Promise<TemplateSelection> = vi.fn(
      async () =>
        ({
          themeId: 'boldfeastv2',
          name: 'Bold Feast v2',
          title: 'Demo Site',
          reasoning: 'Best match',
        }) as TemplateSelection,
    );
    const generateContent = createGenerateContentMock(generatedFiles);
    const workflow = createBootstrapWebsiteWorkflow(undefined, {
      selectTemplate,
      generateContent,
    });

    const result = await workflow.run(
      {
        projectId: 'project-1',
        businessProfile: {
          google_maps_markdown: '# Maps markdown',
        } as BusinessProfile,
        generation: createGenerationInput(),
        runtime: createRuntimeInput(runtimeAdapter),
      },
      {
        writeFile: vi.fn(async () => undefined),
      },
    );

    expect(selectTemplate).toHaveBeenCalledTimes(1);
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(writeFiles).toHaveBeenCalledTimes(generatedFiles.length);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(startPreview).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.generatedFiles).toHaveLength(2);
    expect(result.preview?.url).toContain('sandbox-preview');
  });

  it('enforces bounded build retries and cleans up on failure', async () => {
    const runtimeSession = createRuntimeSessionMock();
    const createSession = vi.fn(async () => runtimeSession);
    const writeFiles = vi.fn(async () => ({ written: 1 }));
    const runCommand = vi.fn(async () => ({
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: 'build failed',
      executionTimeMs: 30,
    }));
    const startPreview = vi.fn(async () => ({
      port: 4173,
      url: 'https://sandbox-preview.example.com',
      command: 'pnpm run dev',
      pid: 1234,
    }));
    const cleanup = vi.fn(async () => undefined);
    const runtimeAdapter: BootstrapRuntimeAdapter = {
      createSession,
      writeFiles,
      runCommand,
      startPreview,
      cleanup,
    };
    const selectTemplate: (
      businessProfile: BusinessProfile,
      fastModel: string,
      provider: ProviderInfo,
      baseUrl: string,
      cookieHeader: string | null,
    ) => Promise<TemplateSelection> = vi.fn(
      async () =>
        ({
          themeId: 'boldfeastv2',
          name: 'Bold Feast v2',
        }) as TemplateSelection,
    );
    const generateContent = createGenerateContentMock(createGeneratedFiles());
    const workflow = createBootstrapWebsiteWorkflow(undefined, {
      selectTemplate,
      generateContent,
    });

    await expect(
      workflow.run(
        {
          projectId: 'project-1',
          businessProfile: {
            google_maps_markdown: '# Maps markdown',
          } as BusinessProfile,
          generation: createGenerationInput(),
          runtime: {
            ...createRuntimeInput(runtimeAdapter),
            installCommand: '',
            maxBuildAttempts: 2,
          },
        },
        {
          writeFile: vi.fn(async () => undefined),
        },
      ),
    ).rejects.toThrow('Build failed after 2 attempts');

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(startPreview).toHaveBeenCalledTimes(0);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
