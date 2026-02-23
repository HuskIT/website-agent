import { describe, expect, it } from 'vitest';
import { adaptBootstrapOutput } from '~/lib/services/v2/bootstrapOutputAdapter';

describe('bootstrapOutputAdapter', () => {
  it('maps generation result into V2 response shape', () => {
    const output = adaptBootstrapOutput({
      projectId: 'project-1',
      generationResult: {
        success: true,
        projectId: 'project-1',
        template: {
          name: 'Bold Feast v2',
          themeId: 'boldfeastv2' as any,
          title: 'Restaurant Website',
          reasoning: 'Matched category',
        },
        files: [{ path: '/app/data/content.ts', content: 'export const x = 1', size: 18 }],
        snapshot: {
          savedAt: '2026-02-23T00:00:00.000Z',
          fileCount: 1,
          sizeMB: 0.01,
        },
        timing: {
          phase1Ms: 100,
          phase2Ms: 200,
          totalMs: 300,
        },
      },
      previewUrl: 'https://preview.example',
    });

    expect(output.success).toBe(true);
    expect(output.projectId).toBe('project-1');
    expect(output.template?.name).toBe('Bold Feast v2');
    expect(output.files.length).toBe(1);
    expect(output.previewUrl).toBe('https://preview.example');
  });

  it('falls back to streamed files and snapshot response', () => {
    const output = adaptBootstrapOutput({
      projectId: 'project-2',
      streamedFiles: [{ path: '/app/main.tsx', content: 'console.log(1)', size: 13 }],
      snapshot: { updated_at: '2026-02-23T01:00:00.000Z' },
      warnings: ['preview pending'],
    });

    expect(output.success).toBe(true);
    expect(output.files.length).toBe(1);
    expect(output.snapshot?.savedAt).toBe('2026-02-23T01:00:00.000Z');
    expect(output.warnings).toEqual(['preview pending']);
  });
});

