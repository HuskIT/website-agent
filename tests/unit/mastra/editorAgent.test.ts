import { describe, expect, it, vi } from 'vitest';
import { createEditorAgent } from '~/lib/mastra/agents/editor';
import type { BusinessProfile } from '~/types/project';

describe('editorAgent', () => {
  it('generates files and maps them to write_file operations', async () => {
    const generateContent = vi.fn(async function* () {
      yield {
        event: 'file' as const,
        data: {
          path: '/home/project/src/data/content.ts',
          content: 'export const content = {};\n',
          size: 26,
        },
      };
      yield {
        event: 'file' as const,
        data: {
          path: '/home/project/README.md',
          content: '# Demo\n',
          size: 7,
        },
      };
    });
    const editor = createEditorAgent({ generateContent });

    const result = await editor.run({
      projectId: 'project-1',
      businessProfile: {
        google_maps_markdown: '# Maps',
      } as BusinessProfile,
      template: {
        themeId: 'boldfeastv2',
        name: 'Bold Feast v2',
      } as any,
      model: 'kimi-for-coding',
      provider: { name: 'Moonshot', staticModels: [] },
      env: undefined,
      apiKeys: {},
      providerSettings: {},
    });

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(result.generatedFiles).toHaveLength(2);
    expect(result.operations).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it('adds warning when content.ts is missing from generated files', async () => {
    const editor = createEditorAgent({
      generateContent: vi.fn(async function* () {
        yield {
          event: 'file' as const,
          data: {
            path: '/home/project/README.md',
            content: '# Demo\n',
            size: 7,
          },
        };
      }),
    });

    const result = await editor.run({
      projectId: 'project-2',
      businessProfile: {} as BusinessProfile,
      template: {
        themeId: 'boldfeastv2',
        name: 'Bold Feast v2',
      } as any,
      model: 'kimi-for-coding',
      provider: { name: 'Moonshot', staticModels: [] },
      env: undefined,
      apiKeys: {},
      providerSettings: {},
    });

    expect(result.warnings).toContain('editor_output_missing_content_file');
  });
});
