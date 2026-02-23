import type { z } from 'zod';

function parseJsonCandidate(candidate: string): unknown | null {
  const normalized = candidate.trim();

  if (!normalized) {
    return null;
  }

  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function extractJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates: string[] = [];

  if (trimmed) {
    candidates.push(trimmed);
  }

  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];

  for (const match of fencedMatches) {
    if (match[1]) {
      candidates.push(match[1].trim());
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  return [...new Set(candidates.filter(Boolean))];
}

export function parseJsonResponseWithSchema<T>(text: string | undefined, schema: z.ZodSchema<T>): T | null {
  if (!text) {
    return null;
  }

  for (const candidate of extractJsonCandidates(text)) {
    const parsed = parseJsonCandidate(candidate);

    if (parsed === null) {
      continue;
    }

    const validation = schema.safeParse(parsed);

    if (validation.success) {
      return validation.data;
    }
  }

  return null;
}
