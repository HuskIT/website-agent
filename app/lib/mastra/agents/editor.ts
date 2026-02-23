import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import type { GeneratedFile } from '~/types/generation';
import type { IProviderSetting, ProviderInfo } from '~/types/model';
import type { BusinessProfile } from '~/types/project';
import type { RestaurantThemeId } from '~/types/restaurant-theme';
import { applyIgnorePatterns, resolveTemplate } from '~/lib/.server/templates';
import type { TemplateSelection } from '~/lib/services/projectGenerationService';
import { composeContentPrompt } from '~/lib/services/v2/promptPack';
import type { FileMutationOperation } from '~/lib/mastra/strategies/fileMutation';
import { resolveMastraAgentModel } from '~/lib/mastra/agents/modelResolver.server';
import { parseJsonResponseWithSchema } from '~/lib/mastra/agents/jsonResponse';
import { STARTER_TEMPLATES, WORK_DIR } from '~/utils/constants';

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
  generateWithMastraAgent?: (input: EditorAgentInput) => Promise<GeneratedFile[] | null>;
}

const EDITOR_MAX_WARNINGS = 8;
const EDITOR_MAX_NOTES = 6;
const EDITOR_CONTENT_FILE_PATH = `${WORK_DIR}/src/data/content.ts`;
const EDITOR_MAX_BUSINESS_CONTEXT_CHARS = 48_000;
const ALLOWED_EVALUATION_WARNING_CODES = new Set([
  'missing_generated_content_file',
  'suspicious_low_file_count',
  'template_content_mismatch',
]);

const editorEvaluationSchema = z.object({
  warnings: z.array(z.string().min(1)).max(EDITOR_MAX_WARNINGS),
  notes: z.array(z.string().min(1)).max(EDITOR_MAX_NOTES),
});
const editorGeneratedFileSchema = z.object({
  path: z.string().min(1),
  content: z.string().min(1),
});

type EditorAgentEvaluation = z.infer<typeof editorEvaluationSchema>;
type EditorGeneratedFile = z.infer<typeof editorGeneratedFileSchema>;

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

function normalizeGeneratedPath(filePath: string): string {
  const trimmedPath = filePath.trim();

  if (!trimmedPath) {
    return EDITOR_CONTENT_FILE_PATH;
  }

  if (trimmedPath.startsWith('/')) {
    return trimmedPath.replace(/\/+/g, '/');
  }

  return `${WORK_DIR}/${trimmedPath}`.replace(/\/+/g, '/');
}

function toGeneratedFile(path: string, content: string): GeneratedFile {
  const normalizedContent = content.trimEnd();
  const safeContent = `${normalizedContent}\n`;

  return {
    path: normalizeGeneratedPath(path),
    content: safeContent,
    size: safeContent.length,
  };
}

function normalizeGeneratedFiles(files: GeneratedFile[]): GeneratedFile[] {
  const latestByPath = new Map<string, GeneratedFile>();

  for (const file of files) {
    const normalized = toGeneratedFile(file.path, file.content);
    latestByPath.set(normalized.path, normalized);
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

function shouldSkipMastraCodingModel(): boolean {
  const isVitest = typeof process !== 'undefined' && Boolean(process.env.VITEST);
  const allowRealVitestModel = typeof process !== 'undefined' && process.env.V2_REAL_RUN_KIMI === 'true';

  if (isVitest && !allowRealVitestModel) {
    return true;
  }

  return process.env.V2_MASTRA_EDITOR_CODING_AGENT_ENABLED === 'false';
}

function clampPromptText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[TRUNCATED_FOR_AGENT_CONTEXT]`;
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

function buildEditorCodingPrompt(input: EditorAgentInput, templateContent: string): string {
  const businessContext = clampPromptText(
    composeContentPrompt(input.businessProfile),
    EDITOR_MAX_BUSINESS_CONTEXT_CHARS,
  );

  return [
    'Generate exactly one file for autonomous website bootstrap.',
    `project_id: ${input.projectId}`,
    `template_theme: ${input.template.themeId}`,
    `target_path: ${EDITOR_CONTENT_FILE_PATH}`,
    '',
    'Requirements:',
    '- Generate complete TypeScript for src/data/content.ts only.',
    '- Preserve template data structure and keys so existing UI components compile.',
    '- Replace placeholders with business data from context.',
    '- Do not generate any other files.',
    '',
    '<template_content_ts>',
    templateContent,
    '</template_content_ts>',
    '',
    '<business_context>',
    businessContext,
    '</business_context>',
    '',
    'Output format requirements:',
    '- Return ONLY a JSON object.',
    '- No markdown, no code fences, no extra commentary.',
    '- JSON shape:',
    `{"path":"${EDITOR_CONTENT_FILE_PATH}","content":"<full TypeScript file>"}`,
  ].join('\n');
}

async function loadTemplateFilesForEditor(input: EditorAgentInput): Promise<GeneratedFile[]> {
  const starterTemplate = STARTER_TEMPLATES.find((template) => template.restaurantThemeId === input.template.themeId);

  if (!starterTemplate) {
    throw new Error(`Starter template not found for theme "${input.template.themeId}"`);
  }

  const resolvedTemplate = await resolveTemplate(starterTemplate.name, {
    githubRepo: starterTemplate.githubRepo,
    githubToken: input.env?.GITHUB_TOKEN,
  });
  const { includedFiles, ignoredFiles } = applyIgnorePatterns(resolvedTemplate.files);
  const allTemplateFiles = [...includedFiles, ...ignoredFiles];

  return allTemplateFiles.map((file) => toGeneratedFile(file.path, file.content));
}

function mergeGeneratedContentFile(templateFiles: GeneratedFile[], generated: EditorGeneratedFile): GeneratedFile[] {
  const mergedFiles = new Map<string, GeneratedFile>();

  for (const file of templateFiles) {
    const normalized = toGeneratedFile(file.path, file.content);
    mergedFiles.set(normalized.path, normalized);
  }

  const contentFile = toGeneratedFile(EDITOR_CONTENT_FILE_PATH, generated.content);
  mergedFiles.set(contentFile.path, contentFile);

  return Array.from(mergedFiles.values());
}

async function generateFilesWithMastraCodingAgent(input: EditorAgentInput): Promise<GeneratedFile[] | null> {
  if (shouldSkipMastraCodingModel()) {
    return null;
  }

  const templateFiles = await loadTemplateFilesForEditor(input);
  const templateContentFile = templateFiles.find((file) => file.path === EDITOR_CONTENT_FILE_PATH);

  if (!templateContentFile) {
    throw new Error(`Template file not found: ${EDITOR_CONTENT_FILE_PATH}`);
  }

  const model = resolveMastraAgentModel({
    model: input.model,
    provider: input.provider,
    env: input.env,
    apiKeys: input.apiKeys,
    providerSettings: input.providerSettings,
  });
  const codingAgent = new Agent({
    id: `${EDITOR_AGENT_ID}-coding-${input.projectId}`,
    name: 'HuskIT Coding Agent',
    instructions: `${EDITOR_AGENT_SYSTEM_PROMPT}\nGenerate src/data/content.ts only.`,
    model: model as any,
  });
  const generation = await codingAgent.generate(buildEditorCodingPrompt(input, templateContentFile.content), {
    maxSteps: 1,
  });
  const parsed = parseJsonResponseWithSchema(generation.text, editorGeneratedFileSchema);

  if (!parsed) {
    throw new Error('Mastra coding agent did not return valid JSON file payload');
  }

  return mergeGeneratedContentFile(templateFiles, parsed);
}

async function collectLegacyGeneratedFiles(
  input: EditorAgentInput,
  generateContent: EditorGenerateContentFn,
): Promise<GeneratedFile[]> {
  const streamedFiles: GeneratedFile[] = [];

  for await (const fileEvent of generateContent(
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

  return normalizeGeneratedFiles(streamedFiles);
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
      const warnings: string[] = [];
      const generateWithMastraAgent = deps.generateWithMastraAgent ?? generateFilesWithMastraCodingAgent;
      let generatedFiles: GeneratedFile[] | null = null;

      try {
        generatedFiles = await generateWithMastraAgent(input);
      } catch (error) {
        warnings.push(
          `editor_coding_agent_fallback:${error instanceof Error ? error.message.slice(0, 120) : 'unknown_error'}`,
        );
      }

      if (!generatedFiles?.length) {
        generatedFiles = await collectLegacyGeneratedFiles(input, deps.generateContent);
      } else {
        generatedFiles = normalizeGeneratedFiles(generatedFiles);
      }

      if (!generatedFiles.some((file) => file.path === EDITOR_CONTENT_FILE_PATH)) {
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
