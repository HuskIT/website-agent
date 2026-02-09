# Data Model: AI SDK v6 Type Mappings

**Feature Branch**: `001-ai-sdk-v6-migration`
**Created**: 2026-02-05

## Overview

This document maps the v4 types to their v6 equivalents and documents the transformation rules for backward compatibility.

---

## Core Type Mappings

### Message Types

| v4 Type | v6 Type | Import Path |
|---------|---------|-------------|
| `CoreMessage` | `ModelMessage` | `import type { ModelMessage } from 'ai'` |
| `Message` (UI) | `UIMessage` | `import type { UIMessage } from 'ai'` |
| `DataStreamString` | Removed | Use `UIMessageStream` |

### Message Structure

```typescript
// v4 CoreMessage
interface CoreMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentPart[];
}

// v6 ModelMessage
interface ModelMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentPart[];
  // Additional v6 fields for attachments, etc.
}
```

### Tool Invocation Parts

```typescript
// v4 ToolCallPart
interface ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: unknown;  // v4 property name
}

// v6 ToolCallPart
interface ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;  // v6 property name (was 'args')
}
```

```typescript
// v4 ToolResultPart
interface ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  result: unknown;  // v4 property name
}

// v6 ToolResultPart
interface ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  output: unknown;  // v6 property name (was 'result')
}
```

---

## Provider Types

### Language Model

| v4 Type | v6 Type | Import Path |
|---------|---------|-------------|
| `LanguageModelV1` | `LanguageModel` | `import type { LanguageModel } from 'ai'` |
| `LanguageModelV1` | `LanguageModelV3` | `import type { LanguageModelV3 } from '@ai-sdk/provider'` |

**Recommendation**: Use the generic `LanguageModel` type for forward compatibility.

### Provider Return Types

```typescript
// v4 Provider
interface BaseProvider {
  getModelInstance(options: { model: string }): LanguageModelV1;
}

// v6 Provider
interface BaseProvider {
  getModelInstance(options: { model: string }): LanguageModel;
}
```

---

## Token Usage Types

### v4 Usage Structure

```typescript
interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}
```

### v6 Usage Structure

```typescript
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
  };
  outputTokenDetails?: {
    reasoningTokens?: number;
  };
}
```

### Mapping

| v4 Property | v6 Property |
|-------------|-------------|
| `promptTokens` | `inputTokens` |
| `completionTokens` | `outputTokens` |
| `cachedInputTokens` | `inputTokenDetails.cacheReadTokens` |
| `reasoningTokens` | `outputTokenDetails.reasoningTokens` |

---

## Tool Definition Types

### v4 Tool Definition

```typescript
import { tool } from 'ai';
import { z } from 'zod';

const myTool = tool({
  description: 'Tool description',
  parameters: z.object({
    field: z.string(),
  }),
  execute: async (args) => {
    return { result: 'value' };
  },
});
```

### v6 Tool Definition

```typescript
import { tool } from 'ai';
import { z } from 'zod';

const myTool = tool({
  description: 'Tool description',
  inputSchema: z.object({
    field: z.string(),
  }),
  outputSchema: z.object({  // optional
    result: z.string(),
  }),
  execute: async (args) => {
    return { result: 'value' };
  },
});
```

---

## Streaming Types

### v4 Streaming

```typescript
import { createDataStream, DataStreamWriter } from 'ai';

const stream = createDataStream({
  execute: async (writer: DataStreamWriter) => {
    writer.writeData({ type: 'progress', value: 50 });
    result.mergeIntoDataStream(writer);
  },
});
```

### v6 Streaming

```typescript
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  UIMessageStreamWriter
} from 'ai';

const stream = createUIMessageStream({
  execute: async ({ writer }: { writer: UIMessageStreamWriter }) => {
    writer.write({ type: 'data-progress', data: { value: 50 } });
    writer.merge(result.toUIMessageStream());
  },
});
return createUIMessageStreamResponse({ stream });
```

---

## MCP Types

### v4 MCP Client

```typescript
import { experimental_createMCPClient } from 'ai';
import { Experimental_StdioMCPTransport } from 'ai/mcp-stdio';
```

### v6 MCP Client

```typescript
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
```

---

## Backward Compatibility Transformation

### Message Transform Function

```typescript
/**
 * Transforms v4 message format to v6 on load.
 * Applied silently when loading persisted messages.
 */
function transformV4ToV6Message(message: unknown): ModelMessage {
  const msg = message as Record<string, unknown>;

  // Transform tool call parts
  if (Array.isArray(msg.content)) {
    msg.content = msg.content.map((part: Record<string, unknown>) => {
      if (part.type === 'tool-call' && 'args' in part) {
        return { ...part, input: part.args, args: undefined };
      }
      if (part.type === 'tool-result' && 'result' in part) {
        return { ...part, output: part.result, result: undefined };
      }
      return part;
    });
  }

  return msg as ModelMessage;
}
```

### Detection Heuristic

```typescript
/**
 * Detects if a message is in v4 format.
 */
function isV4Message(message: unknown): boolean {
  const msg = message as Record<string, unknown>;
  if (!Array.isArray(msg.content)) return false;

  return msg.content.some((part: Record<string, unknown>) => {
    return (part.type === 'tool-call' && 'args' in part) ||
           (part.type === 'tool-result' && 'result' in part);
  });
}
```

---

## Entity Relationships

```
┌─────────────────┐      ┌─────────────────┐
│   UIMessage     │──────│  ModelMessage   │
│   (UI layer)    │ conv │  (LLM layer)    │
└─────────────────┘ ert  └─────────────────┘
        │                        │
        │                        │
        ▼                        ▼
┌─────────────────┐      ┌─────────────────┐
│  Persisted Msg  │◄─────│  ToolCallPart   │
│  (Supabase)     │ has  │  ToolResultPart │
└─────────────────┘      └─────────────────┘
        │
        │ transform on load
        ▼
┌─────────────────┐
│  v4 → v6        │
│  Compatibility  │
└─────────────────┘
```

---

## Files Requiring Type Updates

| File | Type Changes |
|------|--------------|
| `app/lib/modules/llm/types.ts` | `LanguageModelV1` → `LanguageModel` |
| `app/lib/modules/llm/base-provider.ts` | Return type update |
| `app/lib/modules/llm/providers/*.ts` | 20+ files with type updates |
| `app/lib/persistence/*.ts` | Message type compatibility |
| `app/components/chat/*.tsx` | UI message types |
| `app/routes/api.chat.ts` | Streaming + usage types |
| `app/lib/services/mcpService.ts` | MCP + tool part types |
| `app/lib/tools/infoCollectionTools.ts` | Tool definition types |
