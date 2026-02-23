import type { GeneratedFile } from '~/types/generation';
import type { IProviderSetting, ProviderInfo } from '~/types/model';
import type { BusinessProfile } from '~/types/project';
import type { RestaurantThemeId } from '~/types/restaurant-theme';
import type { TemplateSelection } from '~/lib/services/projectGenerationService';
import type { FileMutationOperation } from '~/lib/mastra/strategies/fileMutation';

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
}

function toWriteFileOperations(files: GeneratedFile[]): FileMutationOperation[] {
  return files.map((file) => ({
    path: file.path,
    content: file.content,
  }));
}

export function createEditorAgent(deps: EditorAgentDeps): EditorAgent {
  return {
    id: EDITOR_AGENT_ID,
    layer: EDITOR_AGENT_LAYER,
    systemPrompt: EDITOR_AGENT_SYSTEM_PROMPT,
    async run(input: EditorAgentInput): Promise<EditorAgentOutput> {
      const generatedFiles: GeneratedFile[] = [];

      for await (const fileEvent of deps.generateContent(
        input.businessProfile,
        input.template.themeId as RestaurantThemeId,
        input.model,
        input.provider,
        input.env,
        input.apiKeys,
        input.providerSettings,
      )) {
        generatedFiles.push(fileEvent.data);
      }

      const warnings: string[] = [];

      if (!generatedFiles.some((file) => file.path.endsWith('/src/data/content.ts'))) {
        warnings.push('editor_output_missing_content_file');
      }

      return {
        projectId: input.projectId,
        template: input.template,
        generatedFiles,
        operations: toWriteFileOperations(generatedFiles),
        warnings,
      };
    },
  };
}
