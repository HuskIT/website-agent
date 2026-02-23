import { describe, expect, it, vi } from 'vitest';
import { createPlannerAgent } from '~/lib/mastra/agents/planner';
import type { BusinessProfile } from '~/types/project';

describe('plannerAgent', () => {
  it('selects template and returns deterministic write_file plan', async () => {
    const selectTemplate = vi.fn(async () => ({
      themeId: 'boldfeastv2' as any,
      name: 'Bold Feast v2',
      title: 'Restaurant Website',
      reasoning: 'Best fit',
    }));
    const planner = createPlannerAgent({ selectTemplate });

    const plan = await planner.run({
      projectId: 'project-1',
      businessProfile: {
        google_maps_markdown: '# Maps',
        website_markdown: '# Website',
      } as BusinessProfile,
      fastModel: 'kimi-for-coding',
      fastProvider: { name: 'Moonshot', staticModels: [] },
      baseUrl: 'http://localhost',
      cookieHeader: null,
    });

    expect(selectTemplate).toHaveBeenCalledTimes(1);
    expect(plan.projectId).toBe('project-1');
    expect(plan.template.themeId).toBe('boldfeastv2');
    expect(plan.mutationMode).toBe('write_file');
    expect(plan.targetFiles).toEqual(['/home/project/app/data/content.ts']);
    expect(plan.riskLevel).toBe('low');
  });

  it('marks higher risk when markdown context is missing', async () => {
    const planner = createPlannerAgent({
      selectTemplate: vi.fn(async () => ({
        themeId: 'boldfeastv2' as any,
        name: 'Bold Feast v2',
      })),
    });

    const plan = await planner.run({
      projectId: 'project-2',
      businessProfile: {} as BusinessProfile,
      fastModel: 'kimi-for-coding',
      fastProvider: { name: 'Moonshot', staticModels: [] },
      baseUrl: 'http://localhost',
      cookieHeader: null,
    });

    expect(plan.riskLevel).toBe('high');
  });
});
