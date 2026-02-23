import type { IProviderSetting, ProviderInfo } from '~/types/model';
import type { RestaurantThemeId } from '~/types/restaurant-theme';
import type { BusinessProfile, SaveSnapshotResponse } from '~/types/project';
import type { GeneratedFile, GenerationSSEEvent } from '~/types/generation';
import { createScopedLogger } from '~/utils/logger';
import { getThemeByTemplateName, RESTAURANT_THEMES } from '~/theme-prompts/registry';
import { streamText } from '~/lib/.server/llm/stream-text';
import { saveSnapshot } from '~/lib/services/projects.server';
import type { FileMap } from '~/lib/stores/files';
import { WORK_DIR, MODEL_REGEX, PROVIDER_REGEX, STARTER_TEMPLATES } from '~/utils/constants';
import { getFastModel } from '~/lib/services/fastModelResolver';
import { resolveTemplate, applyIgnorePatterns, buildTemplatePrimingMessages } from '~/lib/.server/templates';
import type { TemplateFile } from '~/lib/.server/templates/github-template-fetcher';
import { createTrace, createGeneration, flushTraces, isLangfuseEnabled } from '~/lib/.server/telemetry/langfuse.server';
import {
  analyzeBusinessProfile,
  buildTemplateSelectionContextPrompt,
  buildTemplateSelectionSystemPrompt,
  composeContentPrompt,
  parseTemplateSelection,
} from '~/lib/services/v2/promptPack';
import { buildPromptTracePayload } from '~/lib/services/v2/promptTrace';
import { validateContentGeneration } from './contentGenerationValidator';

const logger = createScopedLogger('projectGenerationService');

/**
 * Maximum number of content generation attempts before giving up.
 * Used to retry when LLM generates multiple files instead of just content.ts
 */
const MAX_GENERATION_ATTEMPTS = 3;

export interface BusinessProfileValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];

  /**
   * If `true`, generation can proceed using defaults for missing fields.
   * If `false`, generation should not proceed.
   */
  canProceedWithDefaults: boolean;
}

export function validateBusinessProfile(profile: BusinessProfile | null | undefined): BusinessProfileValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!profile) {
    return { valid: false, errors: ['No business profile data'], warnings: [], canProceedWithDefaults: false };
  }

  // Check for either legacy data OR markdown
  const hasLegacyData = !!profile.crawled_data?.name || !!profile.generated_content?.businessIdentity?.displayName;
  const hasMarkdown = !!profile.google_maps_markdown;

  if (!hasLegacyData && !hasMarkdown) {
    errors.push('Business data is required (crawled_data or google_maps_markdown)');
  }

  // Warnings for missing optional data
  if (!profile.website_markdown && !profile.crawled_data?.website) {
    warnings.push('No website data available');
  }

  if (!profile.crawled_data?.address && !hasMarkdown) {
    warnings.push('Address not provided');
  }

  if (!profile.crawled_data?.phone && !hasMarkdown) {
    warnings.push('Phone not provided');
  }

  if (!profile.crawled_data?.hours && !hasMarkdown) {
    warnings.push('Hours not provided');
  }

  const valid = errors.length === 0;

  return {
    valid,
    errors,
    warnings,
    canProceedWithDefaults: valid,
  };
}

export interface TemplateSelection {
  themeId: RestaurantThemeId;
  name: string;
  title?: string;
  reasoning?: string;
}

export interface GenerationOptions {
  /**
   * User's configured model (Phase 2).
   */
  model: string;
  provider: ProviderInfo;

  /**
   * Optional override for fast model/provider (Phase 1).
   */
  fastModel?: string;
  fastProvider?: ProviderInfo;

  /**
   * Request/environment context (required for server generation).
   */
  baseUrl: string;
  cookieHeader: string | null;
  env?: Env;
  apiKeys: Record<string, string>;
  providerSettings: Record<string, IProviderSetting>;
  businessProfile: BusinessProfile;
}

/**
 * Main entrypoint for generating a website for a project.
 *
 * NOTE: Implemented in Phase 3 (US1). Phase 2 only provides the skeleton signature.
 */
export async function* generateProjectWebsite(
  _projectId: string,
  _userId: string,
  options: GenerationOptions,
): AsyncGenerator<GenerationSSEEvent> {
  const startedAt = Date.now();

  // Phase 1: Template selection
  yield {
    event: 'progress',
    data: {
      phase: 'template_selection',
      status: 'in_progress',
      message: 'Analyzing business details',
      percentage: 10,
      startedAt,
    },
  };

  const fastProvider = options.fastProvider ?? options.provider;
  const { model: fastModel } = options.fastModel
    ? { model: options.fastModel }
    : getFastModel(fastProvider, options.model);

  const phase1Start = Date.now();
  const selection = await selectTemplate(
    options.businessProfile,
    fastModel,
    fastProvider,
    options.baseUrl,
    options.cookieHeader,
  );
  const phase1Ms = Date.now() - phase1Start;

  yield {
    event: 'progress',
    data: {
      phase: 'template_selection',
      status: 'completed',
      message: `Template selected: ${selection.name}`,
      percentage: 20,
      startedAt,
      templateName: selection.name,
    },
  };

  yield {
    event: 'template_selected',
    data: {
      name: selection.name,
      themeId: selection.themeId,
      reasoning: selection.reasoning ?? '',
    },
  };

  // Phase 2: Content generation
  yield {
    event: 'progress',
    data: {
      phase: 'content_generation',
      status: 'in_progress',
      message: 'Generating layout & copy',
      percentage: 30,
      startedAt,
      templateName: selection.name,
    },
  };

  const files: GeneratedFile[] = [];
  const phase2Start = Date.now();

  for await (const fileEvent of generateContent(
    options.businessProfile,
    selection.themeId,
    options.model,
    options.provider,
    options.env,
    options.apiKeys,
    options.providerSettings,
  )) {
    files.push(fileEvent.data);
    yield fileEvent;
  }

  const phase2Ms = Date.now() - phase2Start;

  yield {
    event: 'progress',
    data: {
      phase: 'content_generation',
      status: 'in_progress',
      message: 'Final polish & SEO check',
      percentage: 80,
      startedAt,
      templateName: selection.name,
    },
  };

  // Save snapshot (server-side)
  let snapshotUpdatedAt: string | null = null;
  let snapshotError: string | null = null;

  try {
    const fileMap = buildFileMapFromGeneratedFiles(files);

    yield {
      event: 'progress',
      data: {
        phase: 'snapshot_save',
        status: 'in_progress',
        message: 'Saving project',
        percentage: 90,
        startedAt,
        templateName: selection.name,
      },
    };

    const resp = await saveGeneratedSnapshot(_projectId, fileMap, _userId);
    snapshotUpdatedAt = resp.updated_at;
  } catch (error) {
    snapshotError = error instanceof Error ? error.message : String(error);
    logger.error('Snapshot save failed', { error: snapshotError, projectId: _projectId, userId: _userId });
  }

  const totalMs = Date.now() - startedAt;

  yield {
    event: 'complete',
    data: {
      success: true,
      projectId: _projectId,
      template: {
        name: selection.name,
        themeId: selection.themeId,
        title: selection.title ?? 'Website',
        reasoning: selection.reasoning,
      },
      files,
      snapshot: snapshotUpdatedAt
        ? { savedAt: snapshotUpdatedAt, fileCount: files.length, sizeMB: estimateFilesSizeMB(files) }
        : null,
      timing: {
        phase1Ms,
        phase2Ms,
        totalMs,
      },
      error: snapshotError ?? undefined,
    },
  };
}

/**
 * Phase 1: Template selection (fast LLM).
 *
 * NOTE: Implemented in Phase 3 (US1). Phase 2 only provides the skeleton signature.
 */
export async function selectTemplate(
  businessProfile: BusinessProfile,
  fastModel: string,
  provider: ProviderInfo,
  baseUrl: string,
  cookieHeader: string | null,
): Promise<TemplateSelection> {
  const analysis = analyzeBusinessProfile(businessProfile);

  logger.info('[TEMPLATE_SELECTION] Starting', {
    name: businessProfile.generated_content?.businessIdentity?.displayName || businessProfile.crawled_data?.name,
    category: analysis.category,
    cuisine: analysis.cuisine,
    priceTier: analysis.priceTier,
    style: analysis.style,
    rating: analysis.rating,
    reviewsCount: analysis.reviewsCount,
    provider: provider.name,
    model: fastModel,
  });

  // Use the first available theme as fallback (should be a theme that actually exists in RESTAURANT_THEMES)
  const firstAvailableTheme = RESTAURANT_THEMES[0];
  const fallback: TemplateSelection = firstAvailableTheme
    ? {
        themeId: firstAvailableTheme.id,
        name: firstAvailableTheme.templateName,
        title: 'Restaurant Website',
        reasoning: 'Fallback template used due to selection failure.',
      }
    : {
        themeId: 'boldfeastv2',
        name: 'Bold Feast v2',
        title: 'Restaurant Website',
        reasoning: 'Fallback template used due to selection failure.',
      };

  try {
    const system = buildTemplateSelectionSystemPrompt();
    const message = buildTemplateSelectionContextPrompt(businessProfile);
    const selectionPromptTrace = buildPromptTracePayload({
      stage: 'template_selection',
      model: fastModel,
      provider: provider.name,
      metadata: {
        hasGoogleMapsMarkdown: Boolean(businessProfile.google_maps_markdown),
        hasWebsiteMarkdown: Boolean(businessProfile.website_markdown),
        businessName:
          businessProfile.generated_content?.businessIdentity?.displayName || businessProfile.crawled_data?.name || null,
      },
      segments: [
        { label: 'template_selection_system', text: system },
        { label: 'template_selection_context', text: message },
      ],
    });

    logger.info('[PROMPT_TRACE] template selection payload', selectionPromptTrace);

    const response = await fetch(new URL('/api/llmcall', baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body: JSON.stringify({
        system,
        message,
        model: fastModel,
        provider,
      }),
    });

    if (!response.ok) {
      logger.warn('[TEMPLATE_SELECTION] LLM call failed, falling back', {
        status: response.status,
        statusText: response.statusText,
      });
      return fallback;
    }

    const respJson = (await response.json()) as any;

    // Check if the API returned an error
    if (respJson.error) {
      logger.warn('[TEMPLATE_SELECTION] LLM API returned an error, falling back', {
        error: respJson.message || 'Unknown error',
        statusCode: respJson.statusCode,
      });
      return fallback;
    }

    // Extract text from response (handle both old and new AI SDK formats)
    let llmText: string | undefined;

    if (respJson.text) {
      // Old format: { text: "..." }
      llmText = respJson.text;
    } else if (respJson.steps && Array.isArray(respJson.steps) && respJson.steps.length > 0) {
      // New format (AI SDK v6): { steps: [{ content: [{ type: "text", text: "..." }] }] }
      const firstStep = respJson.steps[0];
      const textContent = firstStep?.content?.find?.((c: any) => c.type === 'text');
      llmText = textContent?.text;
    }

    logger.info('[TEMPLATE_SELECTION] Extracted LLM text', {
      hasText: !!llmText,
      textLength: llmText?.length ?? 0,
      textPreview: llmText?.slice(0, 500) ?? '',
    });

    const parsed = parseTemplateSelection(llmText ?? '');

    if (!parsed) {
      logger.warn('[TEMPLATE_SELECTION] Could not parse LLM output, falling back', {
        text: respJson.text ?? '',
        textLength: respJson.text?.length ?? 0,
      });
      return fallback;
    }

    logger.info('[TEMPLATE_SELECTION] Parsed template name', {
      templateName: parsed.templateName,
      reasoning: parsed.reasoning,
      title: parsed.title,
    });

    const theme = getThemeByTemplateName(parsed.templateName);

    if (!theme) {
      logger.warn('[TEMPLATE_SELECTION] Unknown template returned, falling back', {
        templateName: parsed.templateName,
        availableThemes: RESTAURANT_THEMES.map((t) => t.templateName),
      });
      return fallback;
    }

    logger.info('[TEMPLATE_SELECTION] Selected', {
      themeId: theme.id,
      templateName: theme.templateName,
      reasoning: parsed.reasoning,
      title: parsed.title,
      analysis,
    });

    return {
      themeId: theme.id,
      name: theme.templateName,
      title: parsed.title ?? 'Restaurant Website',
      reasoning: parsed.reasoning,
    };
  } catch {
    return fallback;
  }
}

/**
 * Main entry point for content generation with retry logic.
 *
 * Flow:
 * 1. Load template files and yield them immediately (always succeeds)
 * 2. Call LLM to generate content.ts (with retry on validation failure)
 * 3. Validate that only content.ts was generated by LLM
 * 4. If invalid, retry LLM call (discard previous result)
 * 5. If valid, yield content.ts and return
 *
 * @throws Error if all LLM attempts fail validation
 */
export async function* generateContent(
  businessProfile: BusinessProfile,
  themeId: RestaurantThemeId,
  model: string,
  provider: ProviderInfo,
  env: Env | undefined,
  apiKeys: Record<string, string>,
  providerSettings: Record<string, IProviderSetting>,
): AsyncGenerator<{ event: 'file'; data: GeneratedFile }> {
  /*
   * ============================================================================
   * PHASE 1: Load and yield template files (no retry needed)
   * ============================================================================
   */
  logger.info(`[CONTENT_GEN] Phase 1: Loading template for theme: ${themeId}`);

  const template = STARTER_TEMPLATES.find((t) => t.restaurantThemeId === themeId);

  if (!template) {
    throw new Error(`[TEMPLATE_PRIMING] Template not found for themeId: ${themeId}`);
  }

  logger.info(`[TEMPLATE_PRIMING] Using template: ${template.name} (${template.githubRepo})`);

  // Resolve template from zip or GitHub
  const githubToken = env?.GITHUB_TOKEN;
  const resolved = await resolveTemplate(template.name, {
    githubRepo: template.githubRepo,
    githubToken,
  });

  logger.info(`[TEMPLATE_PRIMING] Template loaded from ${resolved.source.type}: ${resolved.files.length} files`);

  // Apply ignore patterns
  const { includedFiles, ignoredFiles } = applyIgnorePatterns(resolved.files);

  logger.info(`[TEMPLATE_PRIMING] After filtering: ${includedFiles.length} included, ${ignoredFiles.length} ignored`);

  // Yield all template files immediately (these are always correct)
  const allTemplateFiles = [...includedFiles, ...ignoredFiles];

  logger.info(`[CONTENT_GEN] Template files (${allTemplateFiles.length}):`);

  for (const file of allTemplateFiles) {
    logger.info(`  [TEMPLATE] ${file.path} (${file.content.length} chars)`);

    // Convert TemplateFile to GeneratedFile by adding size property
    yield {
      event: 'file',
      data: {
        path: file.path,
        content: file.content,
        size: file.content.length,
      },
    };
  }

  logger.info(`[CONTENT_GEN] Yielded ${allTemplateFiles.length} template files`);

  /*
   * ============================================================================
   * PHASE 2: Call LLM to generate content.ts (with retry logic)
   * ============================================================================
   */
  logger.info(`[CONTENT_GEN] Phase 2: Calling LLM to generate content.ts`);

  let attempt = 0;
  let lastValidationError: string | null = null;

  while (attempt < MAX_GENERATION_ATTEMPTS) {
    attempt++;

    logger.info(`[CONTENT_GEN] Starting LLM attempt ${attempt}/${MAX_GENERATION_ATTEMPTS}`);

    // Collect ONLY LLM-generated files from this attempt
    const llmGeneratedFiles: GeneratedFile[] = [];

    try {
      // Execute one LLM call attempt (streams ONLY LLM-generated files, not template)
      for await (const fileEvent of _generateContentAttempt(
        businessProfile,
        themeId,
        model,
        provider,
        env,
        apiKeys,
        providerSettings,
        attempt,
        includedFiles,
        ignoredFiles,
        template.name,
      )) {
        llmGeneratedFiles.push(fileEvent.data);

        // Don't yield yet - wait for validation
      }

      // Stream completed - validate result
      logger.info(`[CONTENT_GEN] LLM attempt ${attempt} completed, generated ${llmGeneratedFiles.length} files`);

      const validation = validateContentGeneration(llmGeneratedFiles);

      if (!validation.valid) {
        // Validation failed
        lastValidationError = validation.reason || 'Validation failed';

        logger.warn(`[CONTENT_GEN] LLM attempt ${attempt} failed validation`, {
          reason: lastValidationError,
          filesDetected: validation.filesDetected,
          willRetry: attempt < MAX_GENERATION_ATTEMPTS,
        });

        // If not last attempt, continue to retry
        if (attempt < MAX_GENERATION_ATTEMPTS) {
          continue; // Don't yield files, just retry
        }

        // Last attempt failed - throw error
        throw new Error(
          `Content generation failed validation after ${MAX_GENERATION_ATTEMPTS} attempts. ` +
            `Last error: ${lastValidationError}. ` +
            `Files detected: ${validation.filesDetected.join(', ')}`,
        );
      }

      // ✓ Validation passed! Yield the valid LLM-generated file(s)
      logger.info(`[CONTENT_GEN] ✓ LLM attempt ${attempt} succeeded - validation passed`);

      for (const file of llmGeneratedFiles) {
        yield { event: 'file', data: file };
      }

      return; // Success - exit
    } catch (error) {
      // LLM call threw an error (network, timeout, etc.)
      const errorMsg = error instanceof Error ? error.message : String(error);

      logger.error(`[CONTENT_GEN] LLM attempt ${attempt} threw error`, {
        error: errorMsg,
        willRetry: attempt < MAX_GENERATION_ATTEMPTS,
      });

      // If last attempt, re-throw
      if (attempt >= MAX_GENERATION_ATTEMPTS) {
        throw new Error(
          `Content generation failed after ${MAX_GENERATION_ATTEMPTS} attempts. ` + `Last error: ${errorMsg}`,
        );
      }

      // Otherwise retry
      lastValidationError = errorMsg;
    }
  }

  // Should never reach here (TypeScript exhaustiveness check)
  throw new Error(`Content generation failed after ${MAX_GENERATION_ATTEMPTS} attempts`);
}

/**
 * Single generation attempt (internal function).
 * Calls LLM to generate content.ts, does NOT load templates or validate.
 *
 * This function primes the LLM with template files (provided as parameters)
 * and asks it to generate ONLY content.ts with business data.
 *
 * @param attemptNumber - Current attempt number (for logging)
 * @param includedFiles - Template files to include in assistant message
 * @param ignoredFiles - Template files marked as read-only
 * @param templateName - Name of the template being used
 */
async function* _generateContentAttempt(
  businessProfile: BusinessProfile,
  themeId: RestaurantThemeId,
  model: string,
  provider: ProviderInfo,
  env: Env | undefined,
  apiKeys: Record<string, string>,
  providerSettings: Record<string, IProviderSetting>,
  attemptNumber: number,
  includedFiles: TemplateFile[],
  ignoredFiles: TemplateFile[],
  templateName: string,
): AsyncGenerator<{ event: 'file'; data: GeneratedFile }> {
  logger.info(`[ATTEMPT_${attemptNumber}] Starting LLM call`);

  const businessName =
    businessProfile.generated_content?.businessIdentity?.displayName ||
    businessProfile.crawled_data?.name ||
    'Restaurant';

  // Create Langfuse trace for content generation
  const traceContext = createTrace(env, {
    name: 'content-generation',
    metadata: { themeId, model, provider: provider.name, businessName, attemptNumber },
    input: { businessName, themeId, model, attemptNumber },
  });

  // Build priming messages using provided template files
  logger.info(
    `[TEMPLATE_PRIMING] Building priming messages with ${includedFiles.length} included, ${ignoredFiles.length} ignored files`,
  );

  const title = businessProfile.generated_content?.businessIdentity?.displayName
    ? `${businessProfile.generated_content.businessIdentity.displayName} Website`
    : 'Restaurant Website';

  const primingMessages = buildTemplatePrimingMessages(
    includedFiles,
    ignoredFiles,
    businessProfile,
    templateName,
    title,
  );

  const assistantMessage = primingMessages.assistantMessage;
  const userMessage = primingMessages.userMessage;

  if (businessProfile.google_maps_markdown && !businessProfile.website_markdown) {
    logger.info(`[CONTENT_GEN] Generating without website analysis (graceful degradation)`);
  }

  // Compose additional system prompt with business data.
  const additionalSystemPrompt = composeContentPrompt(businessProfile);

  // Build messages array - assistant message contains template files
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  messages.push({ role: 'assistant', content: assistantMessage });

  // Add model/provider markers to user message for streamText() parsing
  const fullUserMessage = [`[Model: ${model}]`, '', `[Provider: ${provider.name}]`, '', userMessage].join('\n');

  messages.push({ role: 'user', content: fullUserMessage });
  const generationPromptTrace = buildPromptTracePayload({
    stage: 'content_generation',
    model,
    provider: provider.name,
    metadata: {
      attemptNumber,
      themeId,
      hasGoogleMapsMarkdown: Boolean(businessProfile.google_maps_markdown),
      hasWebsiteMarkdown: Boolean(businessProfile.website_markdown),
      themeInjectionMode: 'system_prompt_only',
    },
    segments: [
      { label: 'template_priming_assistant_message', text: assistantMessage },
      { label: 'template_priming_user_message', text: userMessage },
      { label: 'additional_system_prompt', text: additionalSystemPrompt },
    ],
  });
  logger.info(`[PROMPT_TRACE] content generation payload (attempt ${attemptNumber})`, generationPromptTrace);

  // Create Langfuse generation for streamText - capture full input
  const generation = traceContext
    ? createGeneration(env, traceContext, {
        name: 'stream-text-content',
        model,
        input: {
          userMessage,
          templateName,
          businessName,
          themeId,
          additionalSystemPrompt,
          attemptNumber,
        },
      })
    : null;
  const startTime = performance.now();

  /*
   * streamText() returns an AI SDK stream result with a `textStream` we can parse incrementally.
   * Theme instructions are injected inside stream-text.ts via restaurantThemeId.
   */
  const result = await streamText({
    messages,
    env,
    apiKeys,
    providerSettings,
    chatMode: 'build',
    restaurantThemeId: themeId,
    additionalSystemPrompt,
  });

  const reader = result.textStream.getReader();
  let buffer = '';
  let fullOutput = ''; // Accumulate full LLM output for Langfuse

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      // `textStream` yields string chunks (not bytes).
      buffer += value;
      fullOutput += value; // Capture full output for Langfuse

      /*
       * Extract complete <boltAction ...>...</boltAction> blocks and emit file actions.
       * Keep any trailing partial block in the buffer for the next chunk.
       */
      const extracted = extractFileActionsFromBuffer(buffer);
      buffer = extracted.remaining;

      for (const file of extracted.files) {
        logger.info(`  [LLM_ATTEMPT_${attemptNumber}] ${file.path} (${file.content.length} chars)`);

        // Check if LLM is generating App.tsx (potential overwrite of template)
        if (file.path.includes('App.tsx')) {
          logger.warn(`[DEBUG] LLM generated App.tsx at: ${file.path}`);
          logger.warn(`[DEBUG] LLM App.tsx preview: ${file.content.substring(0, 200)}...`);
        }

        yield { event: 'file', data: file };
      }
    }
  } finally {
    reader.releaseLock();

    // End Langfuse generation with full output
    generation?.end({
      latencyMs: performance.now() - startTime,
      output: fullOutput,
      provider: provider.name,
    });

    // Flush Langfuse traces
    if (isLangfuseEnabled(env)) {
      flushTraces(env).catch((err) => logger.error('Failed to flush Langfuse traces', err));
    }
  }

  logger.info(`[ATTEMPT_${attemptNumber}] LLM streaming completed`);
}

/**
 * Fallback user message when GitHub template fetch fails.
 * This reverts to the original from-scratch generation behavior.
 * Currently unused but kept for future fallback scenarios.
 */
function _buildFallbackUserMessage(businessName: string, _model: string, _providerName: string): string {
  return [
    `Generate a complete production-ready restaurant website for "${businessName}".`,
    '',
    'Use the theme design instructions and business profile provided in the system prompt.',
    'Generate all required files including App.tsx, components, and styles.',
    'Replace ALL placeholder content with actual business data - no lorem ipsum or generic text.',
    '',
    'Begin generating files now.',
    '',
    '## CRITICAL: OUTPUT FORMAT REQUIREMENTS',
    '',
    'You MUST use EXACTLY this format when generating files:',
    '',
    '<boltAction type="file" filePath="path/to/file.ts">',
    'file content goes here',
    '</boltAction>',
    '',
    '**FORBIDDEN FORMATS** (these will NOT be parsed):',
    '- DO NOT use <function_calls> tags',
    '- DO NOT use <invoke> tags',
    '- DO NOT use <parameter> tags',
    '- DO NOT put content in markdown code fences outside the tags',
    '',
    'The content must be INSIDE the <boltAction>...</boltAction> tags.',
  ].join('\n');
}

/**
 * Auto-save generated output to the initial project snapshot.
 *
 * NOTE: Implemented in Phase 3 (US1). Phase 2 only provides the skeleton signature.
 */
export async function saveGeneratedSnapshot(
  projectId: string,
  files: FileMap,
  userId: string,
): Promise<SaveSnapshotResponse> {
  return await saveSnapshot(projectId, { files }, userId);
}

function stripModelProviderMarkers(text: string): string {
  return text.replace(MODEL_REGEX, '').replace(PROVIDER_REGEX, '');
}

function normalizeFilePath(filePath: string): string {
  const cleaned = stripModelProviderMarkers(filePath).trim();

  if (cleaned.startsWith('/')) {
    return cleaned;
  }

  return `${WORK_DIR}/${cleaned}`.replace(/\/+/g, '/');
}

function cleanBoltFileContent(content: string, filePath: string): string {
  const trimmed = stripModelProviderMarkers(content);

  // If the model wrapped content in a single markdown code fence, unwrap it.
  const match = trimmed.match(/^\s*```[\w-]*\n([\s\S]*?)\n\s*```\s*$/);
  const unwrapped = match ? match[1] : trimmed;

  // Unescape XML escaped tags that sometimes appear in streamed output.
  const unescaped = unwrapped.replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  // Keep markdown files as-is (no trailing newline enforcement needed).
  if (filePath.endsWith('.md')) {
    return unescaped.trim();
  }

  return `${unescaped.trim()}\n`;
}

function extractFileActionsFromBuffer(input: string): { files: GeneratedFile[]; remaining: string } {
  const files: GeneratedFile[] = [];
  let cursor = 0;

  while (true) {
    const openIdx = input.indexOf('<boltAction', cursor);

    if (openIdx === -1) {
      break;
    }

    const closeIdx = input.indexOf('</boltAction>', openIdx);

    if (closeIdx === -1) {
      // Keep the partial block in remaining
      break;
    }

    const block = input.slice(openIdx, closeIdx + '</boltAction>'.length);
    cursor = closeIdx + '</boltAction>'.length;

    // Only process file actions
    if (!block.includes('type="file"')) {
      continue;
    }

    const filePathMatch = block.match(/filePath="([^"]+)"/);

    if (!filePathMatch) {
      continue;
    }

    const tagEnd = block.indexOf('>');
    const contentEnd = block.lastIndexOf('</boltAction>');

    if (tagEnd === -1 || contentEnd === -1 || contentEnd <= tagEnd) {
      continue;
    }

    const rawPath = filePathMatch[1];
    const rawContent = block.slice(tagEnd + 1, contentEnd);

    const normalizedPath = normalizeFilePath(rawPath);
    const cleanedContent = cleanBoltFileContent(rawContent, normalizedPath);

    files.push({
      path: normalizedPath,
      content: cleanedContent,
      size: cleanedContent.length,
    });
  }

  return {
    files,
    remaining: input.slice(cursor),
  };
}

function estimateFilesSizeMB(files: GeneratedFile[]): number {
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  return Math.round((totalBytes / (1024 * 1024)) * 100) / 100;
}

function buildFileMapFromGeneratedFiles(files: GeneratedFile[]): FileMap {
  const map: FileMap = {};
  const fileVersions: Map<string, { source: string; index: number; charCount: number }[]> = new Map();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fullPath = normalizeFilePath(file.path);

    // Track all versions of each file for debugging
    if (!fileVersions.has(fullPath)) {
      fileVersions.set(fullPath, []);
    }

    // Heuristic: first batch of files before any duplicates are likely template files
    const existingVersions = fileVersions.get(fullPath)!;
    const isLikelyTemplate = existingVersions.length === 0 && i < 50; // Assume first 50 unique files are template

    fileVersions.get(fullPath)!.push({
      source: isLikelyTemplate ? 'TEMPLATE' : 'LLM',
      index: i,
      charCount: file.content.length,
    });

    // Add folder entries
    const parts = fullPath.split('/').filter(Boolean);
    let current = '';

    for (let j = 0; j < parts.length - 1; j++) {
      current += `/${parts[j]}`;

      if (!map[current]) {
        map[current] = { type: 'folder' };
      }
    }

    map[fullPath] = {
      type: 'file',
      content: file.content,
      isBinary: false,
    };
  }

  // Log files that were overwritten
  for (const [path, versions] of fileVersions) {
    if (versions.length > 1) {
      const winner = versions[versions.length - 1];
      const versionSummary = versions.map((v) => `${v.source}@${v.index}(${v.charCount})`).join(' → ');
      logger.warn(`[FILE_MAP] ${path}: ${versions.length} versions [${versionSummary}], winner=${winner.source}`);
    }
  }

  const uniqueFiles = Object.entries(map).filter(([_, v]) => v?.type === 'file');
  logger.info(`[FILE_MAP] Final count: ${uniqueFiles.length} unique files from ${files.length} total entries`);

  return map;
}
