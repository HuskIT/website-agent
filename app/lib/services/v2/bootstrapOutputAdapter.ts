import type { GenerationResult, GeneratedFile } from '~/types/generation';
import type { SaveSnapshotResponse } from '~/types/project';
import { V2BootstrapResponseSchema, type V2BootstrapResponse } from '~/lib/services/v2/contracts';

interface AdaptBootstrapOutputParams {
  projectId: string;
  generationResult?: GenerationResult | null;
  streamedFiles?: GeneratedFile[];
  snapshot?: SaveSnapshotResponse | null;
  previewUrl?: string | null;
  warnings?: string[];
}

export function adaptBootstrapOutput(params: AdaptBootstrapOutputParams): V2BootstrapResponse {
  const files =
    params.generationResult?.files && params.generationResult.files.length > 0
      ? params.generationResult.files
      : (params.streamedFiles ?? []);

  const snapshotFromGeneration = params.generationResult?.snapshot ?? null;
  const snapshot =
    snapshotFromGeneration ||
    (params.snapshot
      ? {
          savedAt: params.snapshot.updated_at,
          fileCount: files.length,
          sizeMB: 0,
        }
      : null);

  const candidate: V2BootstrapResponse = {
    success: params.generationResult?.success ?? true,
    projectId: params.projectId,
    template: params.generationResult?.template
      ? {
          name: params.generationResult.template.name,
          themeId: params.generationResult.template.themeId,
          title: params.generationResult.template.title,
          reasoning: params.generationResult.template.reasoning,
        }
      : undefined,
    files,
    snapshot,
    previewUrl: params.previewUrl ?? null,
    timing: params.generationResult?.timing,
    warnings: params.warnings,
    error: params.generationResult?.error,
  };

  return V2BootstrapResponseSchema.parse(candidate);
}

