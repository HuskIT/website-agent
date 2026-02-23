export interface PromptTraceSegment {
  label: string;
  text: string;
}

export interface PromptTraceEntry {
  label: string;
  length: number;
  hash: string;
  preview: string;
}

export interface PromptTracePayload {
  stage: string;
  model: string;
  provider: string;
  metadata?: Record<string, unknown>;
  prompts: PromptTraceEntry[];
}

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

function compactPreview(input: string, maxLength: number): string {
  const compact = input.replace(/\s+/g, ' ').trim();

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}…`;
}

export function buildPromptTracePayload(input: {
  stage: string;
  model: string;
  provider: string;
  segments: PromptTraceSegment[];
  metadata?: Record<string, unknown>;
  previewLength?: number;
}): PromptTracePayload {
  const previewLength = input.previewLength ?? 240;

  return {
    stage: input.stage,
    model: input.model,
    provider: input.provider,
    metadata: input.metadata,
    prompts: input.segments.map((segment) => ({
      label: segment.label,
      length: segment.text.length,
      hash: fnv1a32(segment.text),
      preview: compactPreview(segment.text, previewLength),
    })),
  };
}
