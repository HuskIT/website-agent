import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import type { GeneratedFile } from '~/types/generation';
import type { IProviderSetting, ProviderInfo } from '~/types/model';
import type { BusinessProfile } from '~/types/project';
import type { RestaurantThemeId } from '~/types/restaurant-theme';
import type { TemplateSelection } from '~/lib/services/projectGenerationService';
import type { FileMutationOperation } from '~/lib/mastra/strategies/fileMutation';
import { resolveMastraAgentModel } from '~/lib/mastra/agents/modelResolver.server';
import { parseJsonResponseWithSchema } from '~/lib/mastra/agents/jsonResponse';

export const EDITOR_AGENT_ID = 'editorAgent';
export const EDITOR_AGENT_LAYER = 'layer2-smart-editor';

export const EDITOR_AGENT_SYSTEM_PROMPT = `You are HuskIT Editor Agent (Layer 2).
Goal: generate production-ready website files for the selected template.
Rules:
1. Preserve starter template structure and only inject business-specific content.
2. Write files first (write_file strategy).
3. Ensure generated files can pass install/build checks.
4. Keep output deterministic and bounded for retries.`;

export interface EditorAgentInput {
  projectId: string;
  businessProfile: BusinessProfile;
  template: TemplateSelection;
  model: string;
  provider: ProviderInfo;
  env: Env | undefined;
  apiKeys: Record<string, string>;
  providerSettings: Record<string, IProviderSetting>;
}

export interface EditorAgentOutput {
  projectId: string;
  template: TemplateSelection;
  generatedFiles: GeneratedFile[];
  operations: FileMutationOperation[];
  warnings: string[];
}

export interface EditorAgent {
  id: typeof EDITOR_AGENT_ID;
  layer: typeof EDITOR_AGENT_LAYER;
  systemPrompt: string;
  run: (input: EditorAgentInput) => Promise<EditorAgentOutput>;
}

export type EditorGenerateContentFn = (
  businessProfile: BusinessProfile,
  themeId: RestaurantThemeId,
  model: string,
  provider: ProviderInfo,
  env: Env | undefined,
  apiKeys: Record<string, string>,
  providerSettings: Record<string, IProviderSetting>,
) => AsyncGenerator<{ event: 'file'; data: GeneratedFile }>;

export interface EditorAgentDeps {
  generateContent: EditorGenerateContentFn;
  evaluateOutput?: (input: EditorAgentInput, generatedFiles: GeneratedFile[]) => Promise<EditorAgentEvaluation | null>;
}

const EDITOR_MAX_WARNINGS = 8;
const EDITOR_MAX_NOTES = 6;
const ALLOWED_EVALUATION_WARNING_CODES = new Set([
  'missing_generated_content_file',
  'suspicious_low_file_count',
  'template_content_mismatch',
]);

const editorEvaluationSchema = z.object({
  warnings: z.array(z.string().min(1)).max(EDITOR_MAX_WARNINGS),
  notes: z.array(z.string().min(1)).max(EDITOR_MAX_NOTES),
});

type EditorAgentEvaluation = z.infer<typeof editorEvaluationSchema>;

function toWriteFileOperations(files: GeneratedFile[]): FileMutationOperation[] {
  return files.map((file) => ({
    path: file.path,
    content: file.content,
  }));
}

function dedupeLimited(values: string[], limit: number): string[] {
  const deduped = [...new Set(values.map((item) => item.trim()).filter(Boolean))];

  return deduped.slice(0, limit);
}

function normalizeGeneratedFiles(files: GeneratedFile[]): GeneratedFile[] {
  const latestByPath = new Map<string, GeneratedFile>();

  for (const file of files) {
    latestByPath.set(file.path, file);
  }

  return Array.from(latestByPath.values());
}

function normalizeEvaluationWarnings(warnings: string[]): string[] {
  const normalized = warnings
    .map((warning) => warning.trim().toLowerCase())
    .filter((warning) => ALLOWED_EVALUATION_WARNING_CODES.has(warning));

  return dedupeLimited(
    normalized.map((warning) => `editor_eval_${warning}`),
    EDITOR_MAX_WARNINGS,
  );
}

function shouldSkipMastraEditorModel(): boolean {
  const isVitest = typeof process !== 'undefined' && Boolean(process.env.VITEST);
  const allowRealVitestModel = typeof process !== 'undefined' && process.env.V2_REAL_RUN_KIMI === 'true';

  if (isVitest && !allowRealVitestModel) {
    return true;
  }

  return process.env.V2_MASTRA_EDITOR_AGENT_ENABLED === 'false';
}

function buildEditorEvaluationPrompt(input: EditorAgentInput, generatedFiles: GeneratedFile[]): string {
  const fileSummary = generatedFiles.map((file) => `${file.path} (${file.size} bytes)`).join('\n');
  const mapsLength = input.businessProfile.google_maps_markdown?.length ?? 0;
  const websiteLength = input.businessProfile.website_markdown?.length ?? 0;

  return [
    'Evaluate website generation output for bootstrap reliability.',
    'Only emit warnings that are directly verifiable from the provided file list and metrics.',
    'Do not infer missing framework files or package configuration from assumptions.',
    'If uncertain, return an empty warnings list.',
    `project_id: ${input.projectId}`,
    `template_theme: ${input.template.themeId}`,
    `generated_file_count: ${generatedFiles.length}`,
    `google_maps_markdown_length: ${mapsLength}`,
    `website_markdown_length: ${websiteLength}`,
    '',
    'Generated files:',
    fileSummary || '(no files generated)',
    '',
    'Return warnings and concise notes only.',
    'Focus on:',
    '- missing critical content data files',
    '- suspiciously low file count for bootstrap',
    '- mismatched template/content signals',
    '',
    'Allowed warning codes only:',
    '- missing_generated_content_file',
    '- suspicious_low_file_count',
    '- template_content_mismatch',
    '- If none apply, return []',
    '',
    'Output format requirements:',
    '- Return ONLY a JSON object.',
    '- No markdown, no code fences, no extra commentary.',
    '- JSON shape:',
    '{"warnings":["..."],"notes":["..."]}',
  ].join('\n');
}

async function evaluateOutputWithMastraAgent(
  input: EditorAgentInput,
  generatedFiles: GeneratedFile[],
): Promise<EditorAgentEvaluation | null> {
  if (shouldSkipMastraEditorModel()) {
    return null;
  }

  const model = resolveMastraAgentModel({
    model: input.model,
    provider: input.provider,
    env: input.env,
    apiKeys: input.apiKeys,
    providerSettings: input.providerSettings,
  });

  const editor = new Agent({
    id: `${EDITOR_AGENT_ID}-${input.projectId}`,
    name: 'HuskIT Editor Agent',
    instructions: EDITOR_AGENT_SYSTEM_PROMPT,
    model: model as any,
  });
  const evaluation = await editor.generate(buildEditorEvaluationPrompt(input, generatedFiles), {
    maxSteps: 1,
  });

  return parseJsonResponseWithSchema(evaluation.text, editorEvaluationSchema);
}

export function createEditorAgent(deps: EditorAgentDeps): EditorAgent {
  return {
    id: EDITOR_AGENT_ID,
    layer: EDITOR_AGENT_LAYER,
    systemPrompt: EDITOR_AGENT_SYSTEM_PROMPT,
    async run(input: EditorAgentInput): Promise<EditorAgentOutput> {
      const streamedFiles: GeneratedFile[] = [];

      for await (const fileEvent of deps.generateContent(
        input.businessProfile,
        input.template.themeId as RestaurantThemeId,
        input.model,
        input.provider,
        input.env,
        input.apiKeys,
        input.providerSettings,
      )) {
        streamedFiles.push(fileEvent.data);
      }

      const generatedFiles = normalizeGeneratedFiles(streamedFiles);

      const warnings: string[] = [];

      if (!generatedFiles.some((file) => file.path.endsWith('/src/data/content.ts'))) {
        warnings.push('editor_output_missing_content_file');
      }

      try {
        const evaluateOutput = deps.evaluateOutput ?? evaluateOutputWithMastraAgent;
        const evaluation = await evaluateOutput(input, generatedFiles);

        if (evaluation) {
          warnings.push(...normalizeEvaluationWarnings(evaluation.warnings));
        }
      } catch (error) {
        warnings.push(
          `editor_agent_fallback:${error instanceof Error ? error.message.slice(0, 120) : 'unknown_error'}`,
        );
      }

      const normalizedWarnings = dedupeLimited(warnings, EDITOR_MAX_WARNINGS + EDITOR_MAX_NOTES);

      return {
        projectId: input.projectId,
        template: input.template,
        generatedFiles,
        operations: toWriteFileOperations(generatedFiles),
        warnings: normalizedWarnings,
      };
    },
  };
}
