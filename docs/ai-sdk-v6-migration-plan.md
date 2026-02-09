# Vercel AI SDK v4 → v6 Migration Plan

> **Status:** Draft - Awaiting Approval  
> **Created:** 2026-02-05  
> **Estimated Effort:** 3-5 days  
> **Risk Level:** High (complex streaming & MCP integration)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Package Version Updates](#package-version-updates)
3. [Breaking Changes Analysis](#breaking-changes-analysis)
4. [Migration Phases](#migration-phases)
5. [File-by-File Change List](#file-by-file-change-list)
6. [Risk Assessment](#risk-assessment)
7. [Testing Strategy](#testing-strategy)
8. [Rollback Plan](#rollback-plan)

---

## Executive Summary

This document outlines the migration plan from Vercel AI SDK v4.3.16 to v6.0.70. The migration involves significant breaking changes across:

- Core streaming protocol (`createDataStream` → `createUIMessageStream`)
- Message types (`CoreMessage` → `ModelMessage`)
- Tool definitions (`parameters` → `inputSchema`)
- MCP integration (`experimental_createMCPClient` → `@ai-sdk/mcp`)
- Provider packages (all major version updates)

### Key Metrics

| Metric | Value |
|--------|-------|
| Files to modify | ~50+ |
| Provider packages to update | 10 |
| Breaking API changes | 15+ |
| Estimated development time | 3-5 days |
| Testing time | 1-2 days |

---

## Package Version Updates

### Core AI SDK

| Package | Current | Target | Breaking Changes |
|---------|---------|--------|------------------|
| `ai` | 4.3.16 | 6.0.70 | Yes - Major rewrite |

### Provider Packages

| Package | Current | Target | Notes |
|---------|---------|--------|-------|
| `@ai-sdk/openai` | 1.1.2 | 3.0.25 | LanguageModelV3, new Responses API |
| `@ai-sdk/anthropic` | 0.0.39 | 3.0.36 | LanguageModelV3, structured outputs |
| `@ai-sdk/google` | 1.2.19 | 3.0.21 | LanguageModelV3 |
| `@ai-sdk/amazon-bedrock` | 1.0.6 | 4.0.48 | LanguageModelV3 |
| `@ai-sdk/cohere` | 1.0.3 | 3.0.18 | LanguageModelV3 |
| `@ai-sdk/deepseek` | 0.1.3 | 2.0.17 | LanguageModelV3 |
| `@ai-sdk/mistral` | 0.0.43 | 3.0.18 | LanguageModelV3 |

### UI Packages

| Package | Current | Target | Notes |
|---------|---------|--------|-------|
| `@ai-sdk/react` | 1.2.12 | 3.0.72 | New hooks API |
| `@ai-sdk/ui-utils` | 1.2.11 | 1.2.11 | May be deprecated in v6 |

### New Packages to Add

| Package | Version | Purpose |
|---------|---------|---------|
| `@ai-sdk/mcp` | 1.0.18 | Replaces `experimental_createMCPClient` |

### Community Providers

| Package | Current | Target | Risk |
|---------|---------|--------|------|
| `@openrouter/ai-sdk-provider` | 0.0.5 | 2.1.1 | Medium - verify compatibility |
| `ollama-ai-provider` | 0.15.2 | 1.2.0 | Medium - verify compatibility |

### Installation Command

```bash
# Update all packages
pnpm up ai@^6.0.70 \
  @ai-sdk/openai@^3.0.25 \
  @ai-sdk/anthropic@^3.0.36 \
  @ai-sdk/google@^3.0.21 \
  @ai-sdk/amazon-bedrock@^4.0.48 \
  @ai-sdk/cohere@^3.0.18 \
  @ai-sdk/deepseek@^2.0.17 \
  @ai-sdk/mistral@^3.0.18 \
  @ai-sdk/react@^3.0.72 \
  @openrouter/ai-sdk-provider@^2.1.1 \
  ollama-ai-provider@^1.2.0

# Add new MCP package
pnpm add @ai-sdk/mcp@^1.0.18

# Run official codemods
npx @ai-sdk/codemod v6

# Verify types
pnpm typecheck
```

---

## Breaking Changes Analysis

### 1. Message Conversion (Critical)

**Change:** `convertToCoreMessages` → `convertToModelMessages` (now async)

```typescript
// Before (v4)
import { convertToCoreMessages } from 'ai';
const messages = convertToCoreMessages(uiMessages);

// After (v6)
import { convertToModelMessages } from 'ai';
const messages = await convertToModelMessages(uiMessages);
```

**Affected Files:**
- `app/lib/.server/llm/stream-text.ts`
- `app/lib/services/mcpService.ts`

### 2. Streaming Protocol (Critical)

**Change:** Complete rewrite of data stream API

```typescript
// Before (v4)
import { createDataStream } from 'ai';

const dataStream = createDataStream({
  execute: async (dataStream) => {
    dataStream.writeData({ type: 'progress', ... });
    result.mergeIntoDataStream(dataStream);
  }
});

// After (v6)
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';

const stream = createUIMessageStream({
  execute: async ({ writer }) => {
    writer.write({ type: 'data-progress', data: { ... } });
    writer.merge(result.toUIMessageStream());
  }
});
return createUIMessageStreamResponse({ stream });
```

**Affected Files:**
- `app/routes/api.chat.ts` (major rewrite)

### 3. Tool Definition API (Major)

**Change:** `parameters` → `inputSchema`

```typescript
// Before (v4)
import { tool } from 'ai';

const myTool = tool({
  description: 'My tool',
  parameters: z.object({ ... }),  // ❌ Deprecated
  execute: async (args) => { ... }
});

// After (v6)
const myTool = tool({
  description: 'My tool',
  inputSchema: z.object({ ... }),  // ✅ New
  execute: async (args) => { ... }
});
```

**Affected Files:**
- `app/lib/tools/infoCollectionTools.ts`

### 4. MCP Client (Major)

**Change:** Moved to separate package

```typescript
// Before (v4)
import { experimental_createMCPClient } from 'ai';
import { Experimental_StdioMCPTransport } from 'ai/mcp-stdio';

// After (v6)
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
```

**Affected Files:**
- `app/lib/services/mcpService.ts`

### 5. Language Model Types (Major)

**Change:** `LanguageModelV1` → `LanguageModelV3`

```typescript
// Before (v4)
import type { LanguageModelV1 } from 'ai';

// After (v6)
import type { LanguageModelV3 } from '@ai-sdk/provider';
// Or use the generic LanguageModel type
import type { LanguageModel } from 'ai';
```

**Affected Files:**
- `app/lib/modules/llm/types.ts`
- `app/lib/modules/llm/base-provider.ts`
- All files in `app/lib/modules/llm/providers/` (20+ files)

### 6. Tool Invocation Parts (Major)

**Change:** Tool result properties renamed

```typescript
// Before (v4)
if (part.type === 'tool-call') {
  console.log(part.args);    // ❌
}
if (part.type === 'tool-result') {
  console.log(part.result);  // ❌
}

// After (v6)
if (part.type === 'tool-call') {
  console.log(part.input);   // ✅
}
if (part.type === 'tool-result') {
  console.log(part.output);  // ✅
}
```

**Affected Files:**
- `app/lib/services/mcpService.ts`
- `app/routes/api.chat.ts`

### 7. Token Usage Properties (Minor)

**Change:** Usage object structure changed

```typescript
// Before (v4)
usage.promptTokens
usage.completionTokens
usage.cachedInputTokens
usage.reasoningTokens

// After (v6)
usage.inputTokens
usage.outputTokens
usage.inputTokenDetails.cacheReadTokens
usage.outputTokenDetails.reasoningTokens
```

**Affected Files:**
- `app/routes/api.chat.ts`
- Client components displaying usage

### 8. Data Stream Part Format (Major)

**Change:** `formatDataStreamPart` removed

```typescript
// Before (v4)
import { formatDataStreamPart } from 'ai';
dataStream.write(formatDataStreamPart('tool_result', { ... }));

// After (v6)
writer.write({ type: 'tool-result', toolCallId, output: result });
```

**Affected Files:**
- `app/lib/services/mcpService.ts`

---

## Migration Phases

### Phase 0: Preparation (< 1 hour)

- [ ] Create feature branch: `feat/ai-sdk-v6-migration`
- [ ] Ensure all tests pass: `pnpm test`
- [ ] Ensure typecheck passes: `pnpm typecheck`
- [ ] Document current working state (screenshots/recordings)
- [ ] Create backup of package.json and pnpm-lock.yaml

### Phase 1: Dependency Updates (1-2 hours)

- [ ] Update all AI SDK packages (see installation command above)
- [ ] Add new `@ai-sdk/mcp` package
- [ ] Run official codemods: `npx @ai-sdk/codemod v6`
- [ ] Run `pnpm typecheck` to identify remaining issues
- [ ] Commit: "chore: update AI SDK packages to v6"

### Phase 2: Type Migration (2-3 hours)

- [ ] Update `LanguageModelV1` → `LanguageModelV3` in all provider files
- [ ] Update `convertToCoreMessages` → `await convertToModelMessages`
- [ ] Update `Message` type imports where needed
- [ ] Run `pnpm typecheck` - fix all type errors
- [ ] Commit: "refactor: migrate to v6 type system"

### Phase 3: MCP Service Migration (2-3 hours)

- [ ] Update imports to use `@ai-sdk/mcp`
- [ ] Replace `experimental_createMCPClient` → `createMCPClient`
- [ ] Update transport imports
- [ ] Update `formatDataStreamPart` usage
- [ ] Update tool invocation part handling (`args`→`input`, `result`→`output`)
- [ ] Test MCP server connection
- [ ] Commit: "refactor: migrate MCP service to @ai-sdk/mcp"

### Phase 4: Tool Definition Updates (1-2 hours)

- [ ] Update all tool definitions: `parameters` → `inputSchema`
- [ ] Add `outputSchema` where beneficial
- [ ] Update tool strict mode if needed
- [ ] Test tool execution
- [ ] Commit: "refactor: update tool definitions to v6 API"

### Phase 5: Streaming Protocol Migration (1-2 days) ⚠️ CRITICAL

This is the most complex phase requiring significant refactoring.

- [ ] Create new streaming implementation using `createUIMessageStream`
- [ ] Replace `createDataStream` with new pattern
- [ ] Update all `writeData` calls to new format
- [ ] Replace `mergeIntoDataStream` with `writer.merge(result.toUIMessageStream())`
- [ ] Update the custom `TransformStream` logic
- [ ] Update progress/annotation writing
- [ ] Update error handling in stream
- [ ] Test streaming end-to-end
- [ ] Commit: "refactor: migrate to UI Message Stream protocol"

### Phase 6: Client Updates (1 day)

- [ ] Update `useChat` import path if changed
- [ ] Update attachment handling (if using `experimental_attachments`)
- [ ] Update token usage display
- [ ] Update tool invocation UI rendering
- [ ] Test client-server streaming integration
- [ ] Commit: "refactor: update client to v6 streaming protocol"

### Phase 7: Message Persistence (0.5-1 day)

- [ ] Review message structure changes
- [ ] Update persistence helpers if needed
- [ ] Add schema versioning if beneficial
- [ ] Test message save/load cycle
- [ ] Commit: "refactor: update message persistence for v6"

### Phase 8: Testing & Validation (1-2 days)

- [ ] Run full test suite
- [ ] Manual testing of all chat modes
- [ ] Test all provider integrations
- [ ] Test MCP tool approval flow
- [ ] Test stream continuation
- [ ] Performance testing
- [ ] Fix any remaining issues

### Phase 9: Cleanup & Documentation

- [ ] Remove deprecated code
- [ ] Update inline documentation
- [ ] Update CHANGELOG.md
- [ ] Create PR with detailed description
- [ ] Request review

---

## File-by-File Change List

### Critical Files (Must Change)

| File | Changes Required | Complexity |
|------|------------------|------------|
| `app/lib/.server/llm/stream-text.ts` | `convertToModelMessages` (async) | Medium |
| `app/routes/api.chat.ts` | Complete streaming rewrite | **High** |
| `app/lib/services/mcpService.ts` | MCP package migration, tool parts | High |
| `app/lib/tools/infoCollectionTools.ts` | `parameters` → `inputSchema` | Low |

### Provider Files (Type Updates)

| File | Changes Required |
|------|------------------|
| `app/lib/modules/llm/types.ts` | `LanguageModelV1` → `LanguageModelV3` |
| `app/lib/modules/llm/base-provider.ts` | Return type update |
| `app/lib/modules/llm/providers/openai.ts` | Type update |
| `app/lib/modules/llm/providers/anthropic.ts` | Type update |
| `app/lib/modules/llm/providers/google.ts` | Type update |
| `app/lib/modules/llm/providers/amazon-bedrock.ts` | Type update |
| `app/lib/modules/llm/providers/cohere.ts` | Type update |
| `app/lib/modules/llm/providers/deepseek.ts` | Type update |
| `app/lib/modules/llm/providers/mistral.ts` | Type update |
| `app/lib/modules/llm/providers/groq.ts` | Type update |
| `app/lib/modules/llm/providers/huggingface.ts` | Type update |
| `app/lib/modules/llm/providers/hyperbolic.ts` | Type update |
| `app/lib/modules/llm/providers/lmstudio.ts` | Type update |
| `app/lib/modules/llm/providers/moonshot.ts` | Type update |
| `app/lib/modules/llm/providers/ollama.ts` | Type update |
| `app/lib/modules/llm/providers/open-router.ts` | Type update |
| `app/lib/modules/llm/providers/openai-like.ts` | Type update |
| `app/lib/modules/llm/providers/perplexity.ts` | Type update |
| `app/lib/modules/llm/providers/together.ts` | Type update |
| `app/lib/modules/llm/providers/xai.ts` | Type update |
| `app/lib/modules/llm/providers/zai.ts` | Type update |
| `app/lib/modules/llm/providers/github.ts` | Type update |

### Persistence Files (Type/Structure Updates)

| File | Changes Required |
|------|------------------|
| `app/lib/persistence/db.ts` | Message type update |
| `app/lib/persistence/chats.ts` | Message type update |
| `app/lib/persistence/useChatHistory.ts` | Message type update |
| `app/lib/persistence/annotationHelpers.ts` | Annotation structure |
| `app/lib/persistence/messageLoader.ts` | Message type update |
| `app/lib/persistence/messageMerge.ts` | Message type update |
| `app/lib/persistence/messageSort.ts` | Message type update |
| `app/lib/persistence/messageSyncState.ts` | Message type update |
| `app/lib/persistence/messageValidation.ts` | Message type update |

### Client Components (UI Updates)

| File | Changes Required |
|------|------------------|
| `app/components/chat/Chat.client.tsx` | useChat updates, attachments |
| `app/components/chat/BaseChat.tsx` | Message type |
| `app/components/chat/Messages.client.tsx` | Message type |
| `app/components/chat/AssistantMessage.tsx` | JSONValue type |
| `app/components/chat/Markdown.tsx` | Message type |
| `app/components/chat/GitCloneButton.tsx` | Message type |
| `app/components/chat/ImportFolderButton.tsx` | Message type |
| `app/components/git/GitUrlImport.client.tsx` | Message type |

### Other API Routes

| File | Changes Required |
|------|------------------|
| `app/routes/api.llmcall.ts` | generateText updates |
| `app/routes/api.projects.$id.messages.ts` | JSONValue type |

---

## Risk Assessment

### High Risk Areas

| Risk | Impact | Mitigation |
|------|--------|------------|
| Streaming protocol mismatch | Chat completely broken | Extensive testing, feature flag |
| Tool approval flow breakage | MCP tools unusable | Unit tests, manual testing |
| Provider incompatibility | Specific models fail | Test each provider individually |
| Message persistence corruption | Data loss | Schema versioning, migration script |

### Medium Risk Areas

| Risk | Impact | Mitigation |
|------|--------|------------|
| Community provider lag | OpenRouter/Ollama may not work | Fallback to OpenAI-compatible |
| Token usage display incorrect | Minor UI issue | Update usage parsing |
| Strict JSON schema failures | Some tool calls fail | Set `strict: false` per-tool |

### Low Risk Areas

| Risk | Impact | Mitigation |
|------|--------|------------|
| Type import path changes | Build errors | Codemods handle most |
| Deprecated API warnings | Console noise | Update deprecated calls |

---

## Testing Strategy

### Unit Tests

```bash
# Run existing tests after migration
pnpm test

# Focus on specific areas
pnpm exec vitest run app/lib/persistence
pnpm exec vitest run app/lib/tools
```

### Integration Tests

- [ ] Simple chat (no tools) - verify streaming works
- [ ] Tool calling with info collection tools
- [ ] MCP server connection and tool approval
- [ ] Stream continuation (`finishReason === 'length'`)
- [ ] Message persistence round-trip

### Manual Testing Checklist

- [ ] Start new chat, send simple message
- [ ] Test with each major provider (OpenAI, Anthropic, Google)
- [ ] Test MCP tool configuration
- [ ] Test MCP tool execution with approval
- [ ] Test long response with continuation
- [ ] Test file attachments
- [ ] Test message history persistence
- [ ] Test context optimization
- [ ] Test design scheme injection
- [ ] Test restaurant theme injection

### Provider Compatibility Matrix

| Provider | Test Model | Status |
|----------|------------|--------|
| OpenAI | gpt-4o | ⬜ Pending |
| Anthropic | claude-3-5-sonnet | ⬜ Pending |
| Google | gemini-2.0-flash | ⬜ Pending |
| Amazon Bedrock | claude-3-sonnet | ⬜ Pending |
| Mistral | mistral-large | ⬜ Pending |
| Groq | llama-3.3-70b | ⬜ Pending |
| OpenRouter | various | ⬜ Pending |
| Ollama | llama3 | ⬜ Pending |

---

## Rollback Plan

If critical issues are discovered after deployment:

### Immediate Rollback

```bash
# Revert to previous package versions
git checkout HEAD~1 -- package.json pnpm-lock.yaml
pnpm install

# Or revert entire branch
git revert --no-commit HEAD~N..HEAD
```

### Package Version Rollback

```bash
pnpm up ai@4.3.16 \
  @ai-sdk/openai@1.1.2 \
  @ai-sdk/anthropic@0.0.39 \
  # ... other packages
```

### Feature Flag Approach (Recommended)

Consider implementing the migration behind a feature flag:

```typescript
// In api.chat.ts
const useV6Streaming = process.env.AI_SDK_V6 === 'true';

if (useV6Streaming) {
  // New v6 implementation
} else {
  // Legacy v4 implementation
}
```

This allows:
- Gradual rollout
- Quick rollback via env var
- A/B testing between versions

---

## References

- [AI SDK v6 Migration Guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0)
- [AI SDK v5 Migration Guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0)
- [AI SDK Documentation](https://ai-sdk.dev/docs)
- [AI SDK Codemods](https://github.com/vercel/ai/tree/main/packages/codemod)

---

## Approval

- [ ] Technical Lead approval
- [ ] QA sign-off
- [ ] Product Owner approval

---

**Next Steps:**
1. Review this plan
2. Approve to proceed
3. Begin Phase 0 (Preparation)
