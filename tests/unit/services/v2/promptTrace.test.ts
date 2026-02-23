import { describe, expect, it } from 'vitest';
import { buildPromptTracePayload } from '~/lib/services/v2/promptTrace';

describe('promptTrace', () => {
  it('builds deterministic prompt hashes and previews', () => {
    const payload = buildPromptTracePayload({
      stage: 'template_selection',
      model: 'kimi-for-coding',
      provider: 'Moonshot',
      segments: [
        {
          label: 'system',
          text: 'You are selecting the best template.',
        },
        {
          label: 'context',
          text: 'Business Profile:\n- Name: Demo\n- Cuisine: vietnamese',
        },
      ],
      metadata: {
        hasGoogleMapsMarkdown: true,
      },
      previewLength: 40,
    });

    expect(payload.stage).toBe('template_selection');
    expect(payload.model).toBe('kimi-for-coding');
    expect(payload.provider).toBe('Moonshot');
    expect(payload.prompts).toHaveLength(2);
    expect(payload.prompts[0].hash).toMatch(/^[0-9a-f]{8}$/);
    expect(payload.prompts[1].hash).toMatch(/^[0-9a-f]{8}$/);
    expect(payload.prompts[1].preview.length).toBeLessThanOrEqual(41);
  });

  it('normalizes preview whitespace but preserves source length/hash identity', () => {
    const payload = buildPromptTracePayload({
      stage: 'content_generation',
      model: 'kimi-for-coding',
      provider: 'Moonshot',
      segments: [
        {
          label: 'additional_system_prompt',
          text: 'Line 1\n\nLine 2\t\tLine 3',
        },
      ],
      previewLength: 100,
    });

    expect(payload.prompts[0].length).toBe('Line 1\n\nLine 2\t\tLine 3'.length);
    expect(payload.prompts[0].preview).toBe('Line 1 Line 2 Line 3');
  });
});
