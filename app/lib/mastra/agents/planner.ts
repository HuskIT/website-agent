import type { ProviderInfo } from '~/types/model';
import type { BusinessProfile } from '~/types/project';
import type { TemplateSelection } from '~/lib/services/projectGenerationService';

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
}

const DEFAULT_TARGET_FILES = ['/home/project/app/data/content.ts'];

function inferRiskLevel(profile: BusinessProfile): PlannerAgentPlan['riskLevel'] {
  if (profile.google_maps_markdown && profile.website_markdown) {
    return 'low';
  }

  if (profile.google_maps_markdown || profile.crawled_data) {
    return 'medium';
  }

  return 'high';
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

      return {
        projectId: input.projectId,
        template,
        targetFiles: DEFAULT_TARGET_FILES,
        mutationMode: 'write_file',
        riskLevel: inferRiskLevel(input.businessProfile),
        notes: [
          `template_selected:${template.themeId}`,
          `target_files:${DEFAULT_TARGET_FILES.length}`,
          `fast_model:${input.fastModel}`,
        ],
      };
    },
  };
}
