import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { GeneratedFile } from '~/types/generation';
import type { IProviderSetting, ProviderInfo } from '~/types/model';
import type { BusinessProfile } from '~/types/project';
import type { TemplateSelection } from '~/lib/services/projectGenerationService';
import { createEditorAgent, type EditorAgent, type EditorGenerateContentFn } from '~/lib/mastra/agents/editor';
import {
  createPlannerAgent,
  type PlannerAgent,
  type PlannerAgentPlan,
  type PlannerSelectTemplateFn,
} from '~/lib/mastra/agents/planner';
import type {
  FileMutationContext,
  FileMutationOperation,
  FileMutationResult,
  FileMutationStrategy,
} from '~/lib/mastra/strategies/fileMutation';
import {
  E2BRuntimeAdapter,
  type BootstrapRuntimeAdapter,
  type RuntimePreviewInput,
  type RuntimePreviewResult,
  type V2RuntimeSession,
} from '~/lib/mastra/runtime/e2bRuntimeAdapter.server';
import { getDefaultFileMutationStrategy } from '~/lib/mastra/strategies/fileMutation';
import type { V2WorkspaceFactoryInput } from '~/lib/mastra/runtime/workspaceFactory.server';

const fileMutationOperationSchema = z.object({
  path: z.string(),
  content: z.string().optional(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
});

const fileMutationResultSchema = z.object({
  mode: z.enum(['write_file', 'edit_file']),
  applied: z.number(),
  failures: z.array(
    z.object({
      path: z.string(),
      reason: z.string(),
    }),
  ),
});

const templateSelectionSchema = z.object({
  themeId: z.string(),
  name: z.string(),
  title: z.string().optional(),
  reasoning: z.string().optional(),
});

const plannerPlanSchema = z.object({
  projectId: z.string(),
  template: templateSelectionSchema,
  targetFiles: z.array(z.string()),
  mutationMode: z.literal('write_file'),
  riskLevel: z.enum(['low', 'medium', 'high']),
  notes: z.array(z.string()),
});

const generatedFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number(),
});

const providerInfoSchema = z
  .object({
    name: z.string(),
    staticModels: z.array(z.unknown()).optional(),
  })
  .passthrough();

const generationInputSchema = z.object({
  model: z.string(),
  provider: providerInfoSchema,
  fastModel: z.string().optional(),
  fastProvider: providerInfoSchema.optional(),
  baseUrl: z.string(),
  cookieHeader: z.string().nullable().optional(),
  env: z.any().optional(),
  apiKeys: z.record(z.string()).default({}),
  providerSettings: z.record(z.unknown()).default({}),
});

const runtimeWorkspaceSchema = z
  .object({
    projectId: z.string().optional(),
    apiKey: z.string().optional(),
    sandboxId: z.string().optional(),
    workspaceId: z.string().optional(),
    workspaceName: z.string().optional(),
    sandboxTimeoutMs: z.number().optional(),
    sandboxEnv: z.record(z.string()).optional(),
    sandboxMetadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

const runtimePreviewSchema = z.object({
  port: z.number().optional(),
  cwd: z.string().optional(),
  command: z.string().optional(),
  envs: z.record(z.string()).optional(),
});

const runtimeInputSchema = z.object({
  workspace: runtimeWorkspaceSchema,
  installCommand: z.string().optional(),
  buildCommand: z.string().optional(),
  buildCwd: z.string().optional(),
  maxBuildAttempts: z.number().int().min(1).max(5).optional(),
  preview: runtimePreviewSchema.optional(),
});

const workflowInputSchema = z.object({
  projectId: z.string(),
  operations: z.array(fileMutationOperationSchema).optional(),
  businessProfile: z.unknown().optional(),
  generation: generationInputSchema.optional(),
  runtime: runtimeInputSchema.optional(),
});

const runtimePreviewResultSchema = z.object({
  port: z.number(),
  url: z.string(),
  command: z.string(),
  pid: z.number().optional(),
});

const workflowStateSchema = z.object({
  projectId: z.string(),
  mode: z.enum(['mutation_only', 'autonomous']),
  operations: z.array(fileMutationOperationSchema),
  businessProfile: z.unknown().optional(),
  generation: generationInputSchema.optional(),
  runtime: runtimeInputSchema.optional(),
  plan: plannerPlanSchema.nullable(),
  template: templateSelectionSchema.nullable(),
  generatedFiles: z.array(generatedFileSchema),
  mutation: fileMutationResultSchema,
  buildAttempts: z.number(),
  warnings: z.array(z.string()),
  preview: runtimePreviewResultSchema.nullable(),
});

const workflowOutputSchema = z.object({
  projectId: z.string(),
  mutation: fileMutationResultSchema,
  success: z.boolean(),
  plan: plannerPlanSchema.nullable(),
  template: templateSelectionSchema.nullable(),
  generatedFiles: z.array(generatedFileSchema),
  preview: runtimePreviewResultSchema.nullable(),
  buildAttempts: z.number(),
  warnings: z.array(z.string()),
});

const DEFAULT_INSTALL_COMMAND = 'npm install';
const DEFAULT_BUILD_COMMAND = 'npm run build';
const DEFAULT_BUILD_CWD = '/home/project';
const DEFAULT_MAX_BUILD_ATTEMPTS = 2;

function createEmptyMutation(mode: FileMutationStrategy['mode']): FileMutationResult {
  return {
    mode,
    applied: 0,
    failures: [],
  };
}

function isCommandFailure(result: { exitCode: number; success?: boolean }): boolean {
  return result.exitCode !== 0 || result.success === false;
}

function toBuildFailureWarning(attempt: number, stderr: string): string {
  const message = stderr.trim();
  const preview = message ? message.slice(0, 240) : 'unknown build failure';

  return `build_attempt_${attempt}_failed: ${preview}`;
}

async function runShellCommand(
  runtimeAdapter: BootstrapRuntimeAdapter,
  session: V2RuntimeSession,
  command: string,
  cwd: string,
) {
  // Use bash login shell so environment setup scripts (nvm/corepack/pnpm) load correctly on E2B.
  return runtimeAdapter.runCommand(session, 'bash', ['-lc', command], { cwd });
}

export interface BootstrapGenerationInput {
  model: string;
  provider: ProviderInfo;
  fastModel?: string;
  fastProvider?: ProviderInfo;
  baseUrl: string;
  cookieHeader?: string | null;
  env?: Env;
  apiKeys: Record<string, string>;
  providerSettings: Record<string, IProviderSetting>;
}

export interface BootstrapRuntimeInput {
  workspace: V2WorkspaceFactoryInput;
  adapter?: BootstrapRuntimeAdapter;
  installCommand?: string;
  buildCommand?: string;
  buildCwd?: string;
  maxBuildAttempts?: number;
  preview?: RuntimePreviewInput;
}

export interface BootstrapWebsiteInput {
  projectId: string;
  operations?: FileMutationOperation[];
  businessProfile?: BusinessProfile;
  generation?: BootstrapGenerationInput;
  runtime?: BootstrapRuntimeInput;
}

export interface BootstrapWebsiteOutput {
  projectId: string;
  mutation: FileMutationResult;
  success: boolean;
  plan?: PlannerAgentPlan;
  template?: TemplateSelection;
  generatedFiles?: GeneratedFile[];
  preview?: RuntimePreviewResult;
  runtimeSessionId?: string;
  buildAttempts?: number;
  warnings?: string[];
}

export interface BootstrapWebsiteWorkflow {
  id: 'bootstrapWebsite';
  mutationMode: FileMutationStrategy['mode'];
  run: (input: BootstrapWebsiteInput, context: FileMutationContext) => Promise<BootstrapWebsiteOutput>;
}

interface BootstrapWorkflowDeps {
  plannerAgent?: PlannerAgent;
  editorAgent?: EditorAgent;

  // Backward-compatible dependency injection for tests and adapters.
  selectTemplate?: PlannerSelectTemplateFn;
  generateContent?: EditorGenerateContentFn;
}

export function createBootstrapWebsiteWorkflow(
  strategy: FileMutationStrategy = getDefaultFileMutationStrategy(),
  deps: BootstrapWorkflowDeps = {},
): BootstrapWebsiteWorkflow {
  return {
    id: 'bootstrapWebsite',
    mutationMode: strategy.mode,
    async run(input: BootstrapWebsiteInput, context: FileMutationContext): Promise<BootstrapWebsiteOutput> {
      let selectTemplateFn = deps.selectTemplate;
      let generateContentFn = deps.generateContent;
      const getSelectTemplate = async (): Promise<PlannerSelectTemplateFn> => {
        if (!selectTemplateFn) {
          selectTemplateFn = (await import('~/lib/services/projectGenerationService')).selectTemplate;
        }

        if (!selectTemplateFn) {
          throw new Error('selectTemplate dependency is not available');
        }

        return selectTemplateFn;
      };
      const getGenerateContent = async (): Promise<EditorGenerateContentFn> => {
        if (!generateContentFn) {
          generateContentFn = (await import('~/lib/services/projectGenerationService')).generateContent;
        }

        if (!generateContentFn) {
          throw new Error('generateContent dependency is not available');
        }

        return generateContentFn;
      };
      const plannerAgent =
        deps.plannerAgent ??
        createPlannerAgent({
          selectTemplate: async (...args) => (await getSelectTemplate())(...args),
        });
      const editorAgent =
        deps.editorAgent ??
        createEditorAgent({
          async *generateContent(...args) {
            const generator = (await getGenerateContent())(...args);

            for await (const chunk of generator) {
              yield chunk;
            }
          },
        });

      const runtimeAdapter = input.runtime?.adapter ?? new E2BRuntimeAdapter();
      let runtimeSession: V2RuntimeSession | null = null;
      const runtimeWithoutAdapter = input.runtime
        ? {
            workspace: {
              ...input.runtime.workspace,
              projectId: input.projectId,
            },
            installCommand: input.runtime.installCommand,
            buildCommand: input.runtime.buildCommand,
            buildCwd: input.runtime.buildCwd,
            maxBuildAttempts: input.runtime.maxBuildAttempts,
            preview: input.runtime.preview,
          }
        : undefined;
      const workflowInput = workflowInputSchema.parse({
        ...input,
        operations: input.operations ?? [],
        runtime: runtimeWithoutAdapter,
      });

      const prepareContextStep = createStep({
        id: 'prepare_context',
        inputSchema: workflowInputSchema,
        outputSchema: workflowStateSchema,
        execute: async ({ inputData }) => {
          const isAutonomousMode = Boolean(inputData.businessProfile && inputData.generation);
          const mode: 'autonomous' | 'mutation_only' = isAutonomousMode ? 'autonomous' : 'mutation_only';

          if (mode === 'autonomous' && !inputData.businessProfile) {
            throw new Error('businessProfile is required for autonomous bootstrap mode');
          }

          if (mode === 'autonomous' && !inputData.generation) {
            throw new Error('generation config is required for autonomous bootstrap mode');
          }

          return {
            projectId: inputData.projectId,
            mode,
            operations: inputData.operations ?? [],
            businessProfile: inputData.businessProfile,
            generation: inputData.generation,
            runtime: inputData.runtime,
            plan: null,
            template: null,
            generatedFiles: [],
            mutation: createEmptyMutation(strategy.mode),
            buildAttempts: 0,
            warnings: [],
            preview: null,
          };
        },
      });

      const selectTemplateStep = createStep({
        id: 'select_template',
        inputSchema: workflowStateSchema,
        outputSchema: workflowStateSchema,
        execute: async ({ inputData }) => {
          if (inputData.mode === 'mutation_only') {
            return inputData;
          }

          const generation = inputData.generation as BootstrapGenerationInput;
          const businessProfile = inputData.businessProfile as BusinessProfile;
          const plan = await plannerAgent.run({
            projectId: inputData.projectId,
            businessProfile,
            fastModel: generation.fastModel ?? generation.model,
            fastProvider: (generation.fastProvider ?? generation.provider) as ProviderInfo,
            baseUrl: generation.baseUrl,
            cookieHeader: generation.cookieHeader ?? null,
            env: generation.env,
            apiKeys: generation.apiKeys,
            providerSettings: generation.providerSettings as Record<string, IProviderSetting>,
          });

          return {
            ...inputData,
            plan,
            template: plan.template,
          };
        },
      });

      const loadTemplateAndGenerateContentStep = createStep({
        id: 'load_template_and_generate_content',
        inputSchema: workflowStateSchema,
        outputSchema: workflowStateSchema,
        execute: async ({ inputData }) => {
          if (inputData.mode === 'mutation_only') {
            return inputData;
          }

          const generation = inputData.generation as BootstrapGenerationInput;
          const businessProfile = inputData.businessProfile as BusinessProfile;
          const template = (inputData.plan?.template ?? inputData.template) as TemplateSelection | null;

          if (!template?.themeId) {
            throw new Error('Template selection must be completed before content generation');
          }

          const editorResult = await editorAgent.run({
            projectId: inputData.projectId,
            businessProfile,
            template,
            model: generation.model,
            provider: generation.provider as ProviderInfo,
            env: generation.env,
            apiKeys: generation.apiKeys,
            providerSettings: generation.providerSettings as Record<string, IProviderSetting>,
          });

          return {
            ...inputData,
            generatedFiles: editorResult.generatedFiles,
            operations: editorResult.operations,
            warnings: [...inputData.warnings, ...editorResult.warnings],
          };
        },
      });

      const writeFilesToE2BStep = createStep({
        id: 'write_files_to_e2b',
        inputSchema: workflowStateSchema,
        outputSchema: workflowStateSchema,
        execute: async ({ inputData }) => {
          if (inputData.runtime) {
            runtimeSession = await runtimeAdapter.createSession({
              ...inputData.runtime.workspace,
              projectId: inputData.projectId,
            });
          }

          const mutation = runtimeSession
            ? await strategy.mutate(inputData.operations as FileMutationOperation[], {
                writeFile: async (path, content) => {
                  await runtimeAdapter.writeFiles(runtimeSession as V2RuntimeSession, [{ path, content }]);
                },
              })
            : await strategy.mutate(inputData.operations as FileMutationOperation[], context);

          return {
            ...inputData,
            mutation: mutation as FileMutationResult,
          };
        },
      });

      const installAndBuildStep = createStep({
        id: 'install_and_build',
        inputSchema: workflowStateSchema,
        outputSchema: workflowStateSchema,
        execute: async ({ inputData }) => {
          if (!runtimeSession || !inputData.runtime) {
            return inputData;
          }

          const installCommand = inputData.runtime.installCommand ?? DEFAULT_INSTALL_COMMAND;
          const buildCommand = inputData.runtime.buildCommand ?? DEFAULT_BUILD_COMMAND;
          const buildCwd = inputData.runtime.buildCwd ?? DEFAULT_BUILD_CWD;
          const maxBuildAttempts = inputData.runtime.maxBuildAttempts ?? DEFAULT_MAX_BUILD_ATTEMPTS;
          const warnings = [...inputData.warnings];

          if (installCommand.trim()) {
            const installResult = await runShellCommand(runtimeAdapter, runtimeSession, installCommand, buildCwd);

            if (isCommandFailure(installResult)) {
              const installStderr = installResult.stderr || installResult.stdout || 'Unknown install failure';
              throw new Error(`Dependency install failed: ${installStderr}`);
            }
          }

          let buildAttempts = 0;
          let buildSucceeded = false;

          while (buildAttempts < maxBuildAttempts) {
            buildAttempts += 1;

            const buildResult = await runShellCommand(runtimeAdapter, runtimeSession, buildCommand, buildCwd);

            if (!isCommandFailure(buildResult)) {
              buildSucceeded = true;
              break;
            }

            warnings.push(toBuildFailureWarning(buildAttempts, buildResult.stderr || buildResult.stdout || ''));
          }

          if (!buildSucceeded) {
            throw new Error(`Build failed after ${maxBuildAttempts} attempts`);
          }

          return {
            ...inputData,
            buildAttempts,
            warnings,
          };
        },
      });

      const startPreviewStep = createStep({
        id: 'start_preview',
        inputSchema: workflowStateSchema,
        outputSchema: workflowStateSchema,
        execute: async ({ inputData }) => {
          if (!runtimeSession || !inputData.runtime) {
            return inputData;
          }

          const previewInput: RuntimePreviewInput = {
            ...inputData.runtime.preview,
            cwd: inputData.runtime.preview?.cwd ?? inputData.runtime.buildCwd ?? DEFAULT_BUILD_CWD,
          };
          const preview = await runtimeAdapter.startPreview(runtimeSession, previewInput);

          return {
            ...inputData,
            preview,
          };
        },
      });

      const collectArtifactsStep = createStep({
        id: 'collect_artifacts',
        inputSchema: workflowStateSchema,
        outputSchema: workflowOutputSchema,
        execute: async ({ inputData }) => {
          return {
            projectId: inputData.projectId,
            mutation: inputData.mutation as FileMutationResult,
            success: inputData.mutation.failures.length === 0,
            plan: inputData.plan,
            template: inputData.plan?.template ?? inputData.template,
            generatedFiles: inputData.generatedFiles as GeneratedFile[],
            preview: inputData.preview,
            buildAttempts: inputData.buildAttempts,
            warnings: inputData.warnings,
          };
        },
      });

      const workflow = createWorkflow({
        id: 'v2_bootstrap_website',
        inputSchema: workflowInputSchema,
        outputSchema: workflowOutputSchema,
      })
        .then(prepareContextStep)
        .then(selectTemplateStep)
        .then(loadTemplateAndGenerateContentStep)
        .then(writeFilesToE2BStep)
        .then(installAndBuildStep)
        .then(startPreviewStep)
        .then(collectArtifactsStep)
        .commit();

      const run = await workflow.createRun();
      let result: Awaited<ReturnType<typeof run.start>>;

      try {
        result = await run.start({
          inputData: workflowInput,
        });
      } catch (error) {
        if (runtimeSession) {
          await runtimeAdapter.cleanup(runtimeSession).catch(() => undefined);
        }

        throw error;
      }

      if (result.status !== 'success') {
        if (runtimeSession) {
          await runtimeAdapter.cleanup(runtimeSession).catch(() => undefined);
        }

        const reason =
          result.status === 'failed'
            ? result.error.message
            : `bootstrapWebsite workflow failed with status: ${result.status}`;

        throw new Error(reason);
      }

      return {
        projectId: result.result.projectId,
        mutation: result.result.mutation,
        success: result.result.success,
        plan: (result.result.plan as PlannerAgentPlan | null) ?? undefined,
        template: (result.result.template as TemplateSelection | null) ?? undefined,
        generatedFiles: result.result.generatedFiles,
        preview: result.result.preview ?? undefined,
        runtimeSessionId: (runtimeSession as V2RuntimeSession | null)?.sessionId,
        buildAttempts: result.result.buildAttempts,
        warnings: result.result.warnings,
      };
    },
  };
}
