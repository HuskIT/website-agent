# Implementation Plan: Vercel AI SDK v6 Migration

**Branch**: `001-ai-sdk-v6-migration` | **Date**: 2026-02-05 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-ai-sdk-v6-migration/spec.md`
**Reference**: [Migration Plan Document](../../docs/ai-sdk-v6-migration-plan.md)

## Summary

Migrate the website-agent codebase from Vercel AI SDK v4.3.16 to v6.0.70 using a big-bang approach. This involves updating 50+ files across streaming protocols, message types, tool definitions, MCP integration, and 20+ provider files. The migration leverages official codemods for mechanical changes and requires manual updates for streaming protocol and MCP package migration.

## Technical Context

**Language/Version**: TypeScript 5.7.2 (strict mode)
**Primary Dependencies**:
- `ai` 4.3.16 → 6.0.70 (core SDK)
- `@ai-sdk/openai` 1.1.2 → 3.0.25
- `@ai-sdk/anthropic` 0.0.39 → 3.0.36
- `@ai-sdk/google` 1.2.19 → 3.0.21
- `@ai-sdk/amazon-bedrock` 1.0.6 → 4.0.48
- `@ai-sdk/cohere` 1.0.3 → 3.0.18
- `@ai-sdk/deepseek` 0.1.3 → 2.0.17
- `@ai-sdk/mistral` 0.0.43 → 3.0.18
- `@ai-sdk/react` 1.2.12 → 3.0.72
- `@ai-sdk/mcp` 1.0.18 (new package)
- `@openrouter/ai-sdk-provider` 0.0.5 → 2.1.1
- `ollama-ai-provider` 0.15.2 → 1.2.0

**Storage**: Supabase/PostgreSQL (messages persist unchanged at DB layer)
**Testing**: Vitest for unit/integration, manual testing for top 3 providers (OpenAI, Anthropic, Google)
**Target Platform**: Cloudflare Pages (edge functions, 30s timeout)
**Framework**: Remix 2.15.2 with Vite 5.4.11
**Project Type**: Web application (Remix full-stack)
**Performance Goals**: Maintain current performance levels (no regressions)
**Constraints**: 30s Cloudflare edge timeout, big-bang migration (no feature flags)
**Scale/Scope**: 50+ files to modify, 20+ provider files, 10+ API breaking changes

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| Code Quality | ✅ Pass | Typed contracts (Zod), strict TypeScript enforced |
| Testing Discipline | ✅ Pass | Existing tests must pass, manual testing for top 3 providers |
| UX Consistency | ✅ Pass | No user-facing changes (migration is transparent) |
| Performance Budgets | ✅ Pass | Maintaining current levels, no new telemetry required |

**No constitution violations requiring justification.**

## Project Structure

### Documentation (this feature)

```text
specs/001-ai-sdk-v6-migration/
├── plan.md              # This file
├── research.md          # Phase 0: Breaking changes research
├── data-model.md        # Phase 1: Message type mappings
├── quickstart.md        # Phase 1: Migration quick reference
├── contracts/           # Phase 1: Type contracts for v6 APIs
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
# Files requiring modification (grouped by phase from migration doc)

## Phase 1: Dependencies & Codemods
package.json                          # Version updates + @ai-sdk/mcp

## Phase 2: Type Migration (20+ files)
app/lib/modules/llm/types.ts          # LanguageModelV1 → LanguageModelV3
app/lib/modules/llm/base-provider.ts  # Return type update
app/lib/modules/llm/providers/*.ts    # 20+ provider files

## Phase 3: MCP Service Migration
app/lib/services/mcpService.ts        # @ai-sdk/mcp package, tool parts

## Phase 4: Tool Definitions
app/lib/tools/infoCollectionTools.ts  # parameters → inputSchema

## Phase 5: Streaming Protocol (CRITICAL)
app/routes/api.chat.ts                # Complete streaming rewrite
app/lib/.server/llm/stream-text.ts    # convertToModelMessages (async)

## Phase 6: Client Updates
app/components/chat/Chat.client.tsx   # useChat updates
app/components/chat/*.tsx             # Message type updates

## Phase 7: Persistence Layer
app/lib/persistence/*.ts              # Message type compatibility (9 files)
```

**Structure Decision**: Existing Remix web application structure maintained. Changes are in-place updates, not new architecture.

## Complexity Tracking

> No constitution violations requiring justification.

## Migration Phases Overview

Based on [docs/ai-sdk-v6-migration-plan.md](../../docs/ai-sdk-v6-migration-plan.md):

| Phase | Focus | Files | Complexity |
|-------|-------|-------|------------|
| 0 | Preparation | 0 | Low |
| 1 | Dependency Updates + Codemods | 1 | Low |
| 2 | Type Migration | 22+ | Medium |
| 3 | MCP Service Migration | 1 | High |
| 4 | Tool Definition Updates | 1 | Low |
| 5 | Streaming Protocol | 2 | **Critical** |
| 6 | Client Updates | 8+ | Medium |
| 7 | Message Persistence | 9 | Medium |
| 8 | Testing & Validation | 0 | High |
| 9 | Cleanup | 0 | Low |

## Breaking Changes Reference

| Breaking Change | v4 API | v6 API | Impact |
|-----------------|--------|--------|--------|
| Message Conversion | `convertToCoreMessages()` | `await convertToModelMessages()` | async now |
| Streaming Protocol | `createDataStream` | `createUIMessageStream` | complete rewrite |
| Tool Schema | `parameters` | `inputSchema` | rename |
| MCP Client | `experimental_createMCPClient` | `createMCPClient` from `@ai-sdk/mcp` | new package |
| Model Types | `LanguageModelV1` | `LanguageModelV3` | type change |
| Tool Call Parts | `part.args` / `part.result` | `part.input` / `part.output` | rename |
| Token Usage | `promptTokens` / `completionTokens` | `inputTokens` / `outputTokens` | rename + restructure |
| Stream Part Format | `formatDataStreamPart()` | `writer.write({ type, ... })` | new API |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Streaming protocol mismatch | Extensive E2E testing, test all 3 primary providers |
| MCP tool approval breakage | Manual testing of approval flow |
| Community provider lag | Fallback to OpenAI-compatible if needed |
| Message persistence corruption | Silent v4→v6 transform on load |

## Rollback Strategy

Big-bang migration with git-based rollback:
```bash
# If critical issues discovered:
git checkout HEAD~1 -- package.json pnpm-lock.yaml
pnpm install
```

No feature flag parallel paths (per clarification decision).
