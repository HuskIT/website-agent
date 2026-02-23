import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow } from '@mastra/core/workflows';

describe('mastra workflow vNext compile/runtime smoke', () => {
  it('runs a minimal createWorkflow().then().commit() flow', async () => {
    const echoStep = createStep({
      id: 'echo_step',
      inputSchema: z.object({
        value: z.string(),
      }),
      outputSchema: z.object({
        echoed: z.string(),
      }),
      execute: async ({ inputData }) => {
        return {
          echoed: inputData.value,
        };
      },
    });

    const workflow = createWorkflow({
      id: 'v2_step6_compile_smoke',
      inputSchema: z.object({
        value: z.string(),
      }),
      outputSchema: z.object({
        echoed: z.string(),
      }),
    })
      .then(echoStep)
      .commit();

    const run = await workflow.createRun();
    const result = await run.start({
      inputData: {
        value: 'hello mastra',
      },
    });

    expect(result.status).toBe('success');

    if (result.status === 'success') {
      expect(result.result.echoed).toBe('hello mastra');
    }
  });
});
