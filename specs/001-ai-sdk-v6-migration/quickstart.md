# Quickstart: AI SDK v6 Migration

**Feature Branch**: `001-ai-sdk-v6-migration`
**Created**: 2026-02-05

## Quick Reference

This document provides a rapid reference for the most common migration patterns.

---

## 1. Package Updates

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

# Run codemods
npx @ai-sdk/codemod v6

# Verify
pnpm typecheck
```

---

## 2. Common Patterns

### Message Conversion

```typescript
// BEFORE
const messages = convertToCoreMessages(uiMessages);

// AFTER (now async!)
const messages = await convertToModelMessages(uiMessages);
```

### Streaming

```typescript
// BEFORE
import { createDataStream } from 'ai';
const stream = createDataStream({
  execute: async (dataStream) => {
    dataStream.writeData({ type: 'progress', value: 50 });
    result.mergeIntoDataStream(dataStream);
  }
});
return new Response(stream.toReadableStream());

// AFTER
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
const stream = createUIMessageStream({
  execute: async ({ writer }) => {
    writer.write({ type: 'data-progress', data: { value: 50 } });
    writer.merge(result.toUIMessageStream());
  }
});
return createUIMessageStreamResponse({ stream });
```

### Tool Definition

```typescript
// BEFORE
const myTool = tool({
  parameters: z.object({ query: z.string() }),
  execute: async (args) => { ... }
});

// AFTER
const myTool = tool({
  inputSchema: z.object({ query: z.string() }),
  execute: async (input) => { ... }
});
```

### MCP Client

```typescript
// BEFORE
import { experimental_createMCPClient } from 'ai';
import { Experimental_StdioMCPTransport } from 'ai/mcp-stdio';

// AFTER
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
```

### Provider Types

```typescript
// BEFORE
import type { LanguageModelV1 } from 'ai';

// AFTER
import type { LanguageModel } from 'ai';
```

### Tool Parts

```typescript
// BEFORE
if (part.type === 'tool-call') {
  const { args } = part;
}
if (part.type === 'tool-result') {
  const { result } = part;
}

// AFTER
if (part.type === 'tool-call') {
  const { input } = part;
}
if (part.type === 'tool-result') {
  const { output } = part;
}
```

### Token Usage

```typescript
// BEFORE
const { promptTokens, completionTokens } = usage;

// AFTER
const { inputTokens, outputTokens } = usage;
// Detailed breakdown:
// usage.inputTokenDetails?.cacheReadTokens
// usage.outputTokenDetails?.reasoningTokens
```

---

## 3. File-by-File Checklist

### Critical (Do First)

- [ ] `package.json` - Update versions, add @ai-sdk/mcp
- [ ] Run `npx @ai-sdk/codemod v6`
- [ ] `app/routes/api.chat.ts` - Streaming rewrite
- [ ] `app/lib/.server/llm/stream-text.ts` - async convertToModelMessages
- [ ] `app/lib/services/mcpService.ts` - MCP package migration

### Type Updates (Codemods help)

- [ ] `app/lib/modules/llm/types.ts`
- [ ] `app/lib/modules/llm/base-provider.ts`
- [ ] `app/lib/modules/llm/providers/*.ts` (20+ files)

### Tool Updates (Codemods handle)

- [ ] `app/lib/tools/infoCollectionTools.ts`

### Persistence (Type compatibility)

- [ ] `app/lib/persistence/*.ts` (9 files)

### Client Components

- [ ] `app/components/chat/*.tsx` (8+ files)

---

## 4. Testing Checklist

```bash
# Automated
pnpm typecheck    # Must pass
pnpm test         # Must pass

# Manual (Top 3 Providers)
□ OpenAI - Send message, verify streaming
□ Anthropic - Send message, verify streaming
□ Google - Send message, verify streaming

# Manual (Features)
□ Tool calling (info collection)
□ MCP tool with approval
□ Stream continuation (long response)
□ Message persistence (leave and return)
```

---

## 5. Rollback

```bash
# If something goes wrong:
git checkout HEAD~1 -- package.json pnpm-lock.yaml
pnpm install
```

---

## 6. References

- [AI SDK v6 Migration Guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0)
- [AI SDK v5 Migration Guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0)
- [AI SDK Documentation](https://ai-sdk.dev/docs)
- [Local Migration Plan](../../docs/ai-sdk-v6-migration-plan.md)
