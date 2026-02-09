# Research: Vercel AI SDK v6 Migration

**Feature Branch**: `001-ai-sdk-v6-migration`
**Created**: 2026-02-05
**Status**: Complete

## Executive Summary

This research document consolidates findings from the AI SDK v6 migration analysis. All technical decisions are resolved based on official documentation, the migration plan document, and clarification sessions.

---

## 1. Streaming Protocol Migration

### Decision
Use `createUIMessageStream` with the new writer pattern for all streaming responses.

### Rationale
- v6 completely rewrites the streaming API for better type safety and consistency
- `createDataStream` is removed; `createUIMessageStream` is the replacement
- The new pattern provides better integration with React hooks and SSE

### Implementation Pattern

```typescript
// v4 (current)
import { createDataStream } from 'ai';
const dataStream = createDataStream({
  execute: async (dataStream) => {
    dataStream.writeData({ type: 'progress', ... });
    result.mergeIntoDataStream(dataStream);
  }
});

// v6 (target)
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
const stream = createUIMessageStream({
  execute: async ({ writer }) => {
    writer.write({ type: 'data-progress', data: { ... } });
    writer.merge(result.toUIMessageStream());
  }
});
return createUIMessageStreamResponse({ stream });
```

### Alternatives Considered
1. **Partial migration with compatibility layer**: Rejected - AI SDK v6 removes old APIs entirely
2. **Custom streaming implementation**: Rejected - Adds complexity, loses SDK benefits

---

## 2. Message Type System

### Decision
Use `ModelMessage` type and `convertToModelMessages()` (async) for all LLM interactions.

### Rationale
- `CoreMessage` is deprecated in favor of `ModelMessage`
- Conversion function is now async to support attachment processing
- Type changes propagate through the entire message handling pipeline

### Implementation Pattern

```typescript
// v4 (current)
import { convertToCoreMessages } from 'ai';
const messages = convertToCoreMessages(uiMessages);

// v6 (target)
import { convertToModelMessages } from 'ai';
const messages = await convertToModelMessages(uiMessages);
```

### Key Changes
- All callers must add `await`
- Functions calling this must become async if not already
- Type imports change from `CoreMessage` to `ModelMessage`

### Alternatives Considered
1. **Wrapper function for sync compatibility**: Rejected - Would require blocking which is anti-pattern
2. **Lazy conversion**: Rejected - Messages needed immediately for LLM calls

---

## 3. MCP Package Migration

### Decision
Use `@ai-sdk/mcp` package with `createMCPClient` for all MCP operations.

### Rationale
- `experimental_createMCPClient` removed from core `ai` package
- MCP functionality moved to dedicated `@ai-sdk/mcp` package
- Transport classes also moved to the new package

### Implementation Pattern

```typescript
// v4 (current)
import { experimental_createMCPClient } from 'ai';
import { Experimental_StdioMCPTransport } from 'ai/mcp-stdio';

// v6 (target)
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
```

### Breaking Changes in MCP
- Tool invocation parts: `args` → `input`, `result` → `output`
- `formatDataStreamPart` removed; use `writer.write({ type, ... })` directly

### Alternatives Considered
None - this is a forced migration path.

---

## 4. Tool Definition Updates

### Decision
Use `inputSchema` property for all tool definitions.

### Rationale
- `parameters` property deprecated in favor of `inputSchema`
- More explicit naming aligns with JSON Schema terminology
- Optional `outputSchema` available for structured outputs

### Implementation Pattern

```typescript
// v4 (current)
const myTool = tool({
  description: 'My tool',
  parameters: z.object({ ... }),
  execute: async (args) => { ... }
});

// v6 (target)
const myTool = tool({
  description: 'My tool',
  inputSchema: z.object({ ... }),
  execute: async (args) => { ... }
});
```

### Codemods
The official `@ai-sdk/codemod v6` handles this rename automatically.

---

## 5. Provider Type Migration

### Decision
Use `LanguageModel` (generic) or `LanguageModelV3` type for all providers.

### Rationale
- `LanguageModelV1` deprecated; replaced by `LanguageModelV3`
- Generic `LanguageModel` type from `ai` package recommended for forward compatibility
- All provider packages updated to return `LanguageModelV3`

### Implementation Pattern

```typescript
// v4 (current)
import type { LanguageModelV1 } from 'ai';

// v6 (target) - Option A (recommended)
import type { LanguageModel } from 'ai';

// v6 (target) - Option B (explicit)
import type { LanguageModelV3 } from '@ai-sdk/provider';
```

### Files Affected
- `app/lib/modules/llm/types.ts`
- `app/lib/modules/llm/base-provider.ts`
- All 20+ files in `app/lib/modules/llm/providers/`

---

## 6. Token Usage Structure

### Decision
Update all token usage parsing to use new property names.

### Rationale
- Property names changed for clarity and consistency
- Nested details added for cache and reasoning tokens

### Implementation Pattern

```typescript
// v4 (current)
usage.promptTokens
usage.completionTokens
usage.cachedInputTokens
usage.reasoningTokens

// v6 (target)
usage.inputTokens
usage.outputTokens
usage.inputTokenDetails?.cacheReadTokens
usage.outputTokenDetails?.reasoningTokens
```

### Files Affected
- `app/routes/api.chat.ts`
- Any client components displaying token usage

---

## 7. Backward Compatibility for Messages

### Decision
Implement silent auto-transform of v4 messages to v6 format on load.

### Rationale
- Users should not need to take any action
- Persisted messages in Supabase remain unchanged at DB layer
- Transform happens at application layer during message loading

### Implementation Approach
1. Detect v4 message format (absence of v6-specific fields)
2. Transform message structure on read
3. No database migration required

### Transformation Rules
- Tool call parts: `args` → `input`
- Tool result parts: `result` → `output`
- Message types: `CoreMessage` fields → `ModelMessage` fields

---

## 8. Community Provider Compatibility

### Decision
Update community providers to v6-compatible versions; fallback to OpenAI-compatible if issues.

### Research Findings

| Provider | Target Version | Compatibility Status |
|----------|----------------|---------------------|
| `@openrouter/ai-sdk-provider` | 2.1.1 | ✅ v6 compatible |
| `ollama-ai-provider` | 1.2.0 | ✅ v6 compatible |

### Fallback Strategy
If community providers fail:
1. OpenRouter: Use OpenAI-compatible endpoint
2. Ollama: Use OpenAI-compatible local endpoint

---

## 9. Codemod Effectiveness

### Decision
Run official codemods first, then manual fixes for remaining issues.

### Codemods Handle
- Import path changes
- `parameters` → `inputSchema` renames
- Some type renames

### Manual Fixes Required
- Streaming protocol (complete rewrite)
- MCP package migration
- `await` additions for async changes
- Custom streaming logic updates

### Command
```bash
npx @ai-sdk/codemod v6
```

---

## 10. Testing Strategy

### Decision
Top 3 providers (OpenAI, Anthropic, Google) require explicit manual testing.

### Test Matrix

| Test Area | Automated | Manual (Top 3) |
|-----------|-----------|----------------|
| TypeScript compilation | ✅ | - |
| Unit tests | ✅ | - |
| Streaming response | - | ✅ |
| Tool calling | - | ✅ |
| MCP approval flow | - | ✅ |
| Stream continuation | - | ✅ |
| Message persistence | ✅ | ✅ |

### Test Commands
```bash
pnpm typecheck    # Must pass with 0 errors
pnpm test         # All tests must pass
# Then manual testing per checklist
```

---

## Summary

All research items resolved. No remaining "NEEDS CLARIFICATION" items.

| Topic | Decision |
|-------|----------|
| Streaming Protocol | `createUIMessageStream` + writer pattern |
| Message Types | `ModelMessage` + async `convertToModelMessages` |
| MCP Package | `@ai-sdk/mcp` with `createMCPClient` |
| Tool Definitions | `inputSchema` property |
| Provider Types | Generic `LanguageModel` type |
| Token Usage | New property names with nested details |
| Backward Compat | Silent v4→v6 transform on load |
| Community Providers | v6 versions available |
| Codemods | Run first, manual fixes for streaming/MCP |
| Testing | Top 3 providers manual, rest automated |
