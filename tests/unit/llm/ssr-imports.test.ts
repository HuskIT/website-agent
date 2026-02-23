import { describe, expect, it } from 'vitest';

describe('ssr imports', () => {
  it('imports stream-text module', async () => {
    const mod = await import('~/lib/.server/llm/stream-text');
    expect(typeof mod.streamText).toBe('function');
  });

  it('imports projectGenerationService module', async () => {
    const mod = await import('~/lib/services/projectGenerationService');
    expect(typeof mod.selectTemplate).toBe('function');
  });
});
