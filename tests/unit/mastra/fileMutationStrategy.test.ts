import { describe, expect, it, vi } from 'vitest';
import {
  WriteFileStrategy,
  getDefaultFileMutationStrategy,
  EditFileStrategy,
} from '~/lib/mastra/strategies/fileMutation';
import { createMastraCore } from '~/lib/mastra/factory.server';

describe('mastra file mutation strategy', () => {
  it('uses write_file as the default mutation strategy', () => {
    const strategy = getDefaultFileMutationStrategy();
    const core = createMastraCore();

    expect(strategy.mode).toBe('write_file');
    expect(core.mutationStrategy.mode).toBe('write_file');
    expect(core.bootstrapWebsite.mutationMode).toBe('write_file');
    expect(core.editWebsite.mutationMode).toBe('write_file');
  });

  it('applies write operations through WriteFileStrategy', async () => {
    const strategy = new WriteFileStrategy();
    const writeFile = vi.fn(async () => undefined);

    const result = await strategy.mutate(
      [
        { path: '/app/data/content.ts', content: 'export const content = {};' },
        { path: '/app/components/Hero.tsx', content: 'export const Hero = () => null;' },
      ],
      { writeFile },
    );

    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(result.mode).toBe('write_file');
    expect(result.applied).toBe(2);
    expect(result.failures).toHaveLength(0);
  });

  it('returns failures when write_file operation is missing content', async () => {
    const strategy = new WriteFileStrategy();
    const writeFile = vi.fn(async () => undefined);

    const result = await strategy.mutate([{ path: '/app/data/content.ts' }], { writeFile });

    expect(writeFile).toHaveBeenCalledTimes(0);
    expect(result.applied).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toContain('Missing content');
  });

  it('reports edit_file failure when context does not provide editFile', async () => {
    const strategy = new EditFileStrategy();
    const writeFile = vi.fn(async () => undefined);

    const result = await strategy.mutate([{ path: '/app/data/content.ts', oldText: 'a', newText: 'b' }], { writeFile });

    expect(result.mode).toBe('edit_file');
    expect(result.applied).toBe(0);
    expect(result.failures).toHaveLength(1);
  });

  it('runs bootstrapWebsite through mastra workflow vNext and applies write_file operations', async () => {
    const writeFile = vi.fn(async () => undefined);
    const core = createMastraCore();

    const result = await core.bootstrapWebsite.run(
      {
        projectId: 'project-1',
        operations: [{ path: '/home/user/src/data/content.ts', content: 'export const content = {};' }],
      },
      { writeFile },
    );

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(result.projectId).toBe('project-1');
    expect(result.mutation.mode).toBe('write_file');
    expect(result.success).toBe(true);
  });
});
