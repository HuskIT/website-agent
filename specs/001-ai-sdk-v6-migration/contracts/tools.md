# AI SDK v6 Tool Definition Contract

## Overview

Defines the contract for tool definitions in v6, used in `app/lib/tools/infoCollectionTools.ts` and MCP service.

## Tool Definition Schema

### v6 Tool Structure

```typescript
import { tool } from 'ai';
import { z } from 'zod';

const exampleTool = tool({
  // Required
  description: string;
  inputSchema: z.ZodSchema;  // was 'parameters' in v4
  execute: (input: T) => Promise<R>;

  // Optional
  outputSchema?: z.ZodSchema;
  experimental_toToolResultContent?: (result: R) => ToolResultContent;
});
```

## Property Mapping

| v4 Property | v6 Property | Notes |
|-------------|-------------|-------|
| `parameters` | `inputSchema` | Renamed for clarity |
| N/A | `outputSchema` | New optional field |
| `execute(args)` | `execute(input)` | Parameter semantically same |

## Zod Schema Requirements

```typescript
// Input schema defines tool parameters
inputSchema: z.object({
  query: z.string().describe('Search query'),
  limit: z.number().optional().describe('Max results'),
});

// Output schema defines expected return type (optional)
outputSchema: z.object({
  results: z.array(z.object({
    id: z.string(),
    name: z.string(),
  })),
  total: z.number(),
});
```

## Tool Invocation Parts

### Tool Call Part (in messages)

```typescript
// v4
interface ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: unknown;  // v4 name
}

// v6
interface ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;  // v6 name
}
```

### Tool Result Part (in messages)

```typescript
// v4
interface ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  result: unknown;  // v4 name
}

// v6
interface ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  output: unknown;  // v6 name
}
```

## Migration Example

```typescript
// v4 (deprecated)
const searchTool = tool({
  description: 'Search for restaurants',
  parameters: z.object({
    query: z.string(),
    location: z.string().optional(),
  }),
  execute: async (args) => {
    const { query, location } = args;
    return await search(query, location);
  },
});

// v6
const searchTool = tool({
  description: 'Search for restaurants',
  inputSchema: z.object({
    query: z.string(),
    location: z.string().optional(),
  }),
  execute: async (input) => {
    const { query, location } = input;
    return await search(query, location);
  },
});
```

## Affected Files

- `app/lib/tools/infoCollectionTools.ts` - All tool definitions
- `app/lib/services/mcpService.ts` - Tool invocation part handling
- `app/routes/api.chat.ts` - Tool result handling in stream
