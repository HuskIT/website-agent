import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import type { IProviderSetting, ProviderInfo } from '~/types/model';
import type { BusinessProfile } from '~/types/project';
import type { TemplateSelection } from '~/lib/services/projectGenerationService';
import { resolveMastraAgentModel } from '~/lib/mastra/agents/modelResolver.server';
import { parseJsonResponseWithSchema } from '~/lib/mastra/agents/jsonResponse';

export const PLANNER_AGENT_ID = 'plannerAgent';
export const PLANNER_AGENT_LAYER = 'layer1-cheap-fast';

export const PLANNER_AGENT_SYSTEM_PROMPT = `You are HuskIT Planner Agent (Layer 1).
Goal: pick the best template and produce a safe execution plan for non-technical users.
Rules:
1. Keep planning deterministic and minimal-risk.
2. Select a template that best matches restaurant style and content.
3. Default mutation strategy is write_file.
4. Produce only files required for initial generation.
5. Return concise planning notes for observability.`;

export interface PlannerAgentInput {
  projectId: string;
  businessProfile: BusinessProfile;
  fastModel: string;
  fastProvider: ProviderInfo;
  baseUrl: string;
  cookieHeader: string | null;
  env?: Env;
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
}

export interface PlannerAgentPlan {
  projectId: string;
  template: TemplateSelection;
  targetFiles: string[];
  mutationMode: 'write_file';
  riskLevel: 'low' | 'medium' | 'high';
  notes: string[];
}

export interface PlannerAgent {
  id: typeof PLANNER_AGENT_ID;
  layer: typeof PLANNER_AGENT_LAYER;
  systemPrompt: string;
  run: (input: PlannerAgentInput) => Promise<PlannerAgentPlan>;
}

export type PlannerSelectTemplateFn = (
  businessProfile: BusinessProfile,
  fastModel: string,
  provider: ProviderInfo,
  baseUrl: string,
  cookieHeader: string | null,
) => Promise<TemplateSelection>;

export interface PlannerAgentDeps {
  selectTemplate: PlannerSelectTemplateFn;
  evaluatePlan?: (input: PlannerAgentInput, template: TemplateSelection) => Promise<PlannerAgentDecision | null>;
}

const DEFAULT_TARGET_FILES = ['/home/project/app/data/content.ts'];
const DEFAULT_MUTATION_MODE: PlannerAgentPlan['mutationMode'] = 'write_file';
const PLANNER_MAX_NOTES = 6;

const plannerDecisionSchema = z.object({
  riskLevel: z.enum(['low', 'medium', 'high']),
  targetFiles: z.array(z.string().min(1)).min(1).max(8),
  mutationMode: z.literal('write_file'),
  notes: z.array(z.string().min(1)).min(1).max(PLANNER_MAX_NOTES),
});

type PlannerAgentDecision = z.infer<typeof plannerDecisionSchema>;

function inferRiskLevel(profile: BusinessProfile): PlannerAgentPlan['riskLevel'] {
  if (profile.google_maps_markdown && profile.website_markdown) {
    return 'low';
  }

  if (profile.google_maps_markdown || profile.crawled_data) {
    return 'medium';
  }

  return 'high';
}

function dedupeAndTrimNotes(notes: string[]): string[] {
  const uniqueNotes = [...new Set(notes.map((note) => note.trim()).filter(Boolean))];

  return uniqueNotes.slice(0, PLANNER_MAX_NOTES);
}

function shouldSkipMastraPlanningModel(): boolean {
  const isVitest = typeof process !== 'undefined' && Boolean(process.env.VITEST);
  const allowRealVitestModel = typeof process !== 'undefined' && process.env.V2_REAL_RUN_KIMI === 'true';

  if (isVitest && !allowRealVitestModel) {
    return true;
  }

  return process.env.V2_MASTRA_PLANNER_AGENT_ENABLED === 'false';
}

function buildPlannerPrompt(input: PlannerAgentInput, template: TemplateSelection): string {
  const profile = input.businessProfile;
  const mapsLength = profile.google_maps_markdown?.length ?? 0;
  const websiteLength = profile.website_markdown?.length ?? 0;
  const hasCrawlerData = Boolean(profile.crawled_data);

  return [
    'Project bootstrap planning context:',
    `project_id: ${input.projectId}`,
    `selected_template: ${template.themeId}`,
    `selected_template_name: ${template.name}`,
    `google_maps_markdown_length: ${mapsLength}`,
    `website_markdown_length: ${websiteLength}`,
    `has_crawled_data: ${hasCrawlerData}`,
    '',
    'Return an execution plan for autonomous first-generation website bootstrap.',
    'Constraints:',
    '- mutationMode must be write_file.',
    '- Keep targetFiles minimal and safe.',
    '- Prefer content data files over broad multi-file edits.',
    '- riskLevel must be low, medium, or high.',
    '- Notes must be concise observability facts.',
    '',
    'Output format requirements:',
    '- Return ONLY a JSON object.',
    '- No markdown, no code fences, no extra commentary.',
    '- JSON shape:',
    '{"riskLevel":"low|medium|high","targetFiles":["/home/project/src/data/content.ts"],"mutationMode":"write_file","notes":["..."]}',
  ].join('\n');
}

async function evaluatePlanWithMastraAgent(
  input: PlannerAgentInput,
  template: TemplateSelection,
): Promise<PlannerAgentDecision | null> {
  if (shouldSkipMastraPlanningModel()) {
    return null;
  }

  const model = resolveMastraAgentModel({
    model: input.fastModel,
    provider: input.fastProvider,
    env: input.env,
    apiKeys: input.apiKeys,
    providerSettings: input.providerSettings,
  });

  const planner = new Agent({
    id: `${PLANNER_AGENT_ID}-${input.projectId}`,
    name: 'HuskIT Planner Agent',
    instructions: PLANNER_AGENT_SYSTEM_PROMPT,
    model: model as any,
  });
  const evaluation = await planner.generate(buildPlannerPrompt(input, template), {
    maxSteps: 1,
  });

  return parseJsonResponseWithSchema(evaluation.text, plannerDecisionSchema);
}

export function createPlannerAgent(deps: PlannerAgentDeps): PlannerAgent {
  return {
    id: PLANNER_AGENT_ID,
    layer: PLANNER_AGENT_LAYER,
    systemPrompt: PLANNER_AGENT_SYSTEM_PROMPT,
    async run(input: PlannerAgentInput): Promise<PlannerAgentPlan> {
      const template = await deps.selectTemplate(
        input.businessProfile,
        input.fastModel,
        input.fastProvider,
        input.baseUrl,
        input.cookieHeader,
      );
      const fallbackRiskLevel = inferRiskLevel(input.businessProfile);
      const fallbackNotes = [
        `template_selected:${template.themeId}`,
        `target_files:${DEFAULT_TARGET_FILES.length}`,
        `fast_model:${input.fastModel}`,
      ];
      let decision: PlannerAgentDecision | null = null;

      try {
        const evaluatePlan = deps.evaluatePlan ?? evaluatePlanWithMastraAgent;
        decision = await evaluatePlan(input, template);
      } catch (error) {
        fallbackNotes.push(
          `planner_agent_fallback:${error instanceof Error ? error.message.slice(0, 120) : 'unknown_error'}`,
        );
      }

      const targetFiles = decision?.targetFiles?.length ? decision.targetFiles : DEFAULT_TARGET_FILES;
      const riskLevel = decision?.riskLevel ?? fallbackRiskLevel;
      const notes = dedupeAndTrimNotes([...(decision?.notes ?? []), ...fallbackNotes]);

      return {
        projectId: input.projectId,
        template,
        targetFiles,
        mutationMode: decision?.mutationMode ?? DEFAULT_MUTATION_MODE,
        riskLevel,
        notes,
      };
    },
  };
}
