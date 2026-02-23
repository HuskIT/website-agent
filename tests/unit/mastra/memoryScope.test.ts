import { describe, expect, it } from 'vitest';
import { buildBootstrapMemoryScope } from '~/lib/mastra/memory/scope';

describe('memory scope', () => {
  it('builds project/thread scope ids for bootstrap sessions', () => {
    const scope = buildBootstrapMemoryScope('project-123', 'session-abc');

    expect(scope).toEqual({
      resourceId: 'project:project-123',
      threadId: 'bootstrap:session-abc',
    });
  });
});
