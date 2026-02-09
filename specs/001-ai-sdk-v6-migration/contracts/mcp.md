# AI SDK v6 MCP Contract

## Overview

Defines the contract for MCP (Model Context Protocol) integration using the new `@ai-sdk/mcp` package.

## Package Migration

### Import Changes

```typescript
// v4 (deprecated)
import { experimental_createMCPClient } from 'ai';
import { Experimental_StdioMCPTransport } from 'ai/mcp-stdio';

// v6
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
```

## MCP Client Interface

### Creating Client

```typescript
import { createMCPClient } from '@ai-sdk/mcp';

const client = await createMCPClient({
  transport: new Experimental_StdioMCPTransport({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-example'],
  }),
});
```

### Getting Tools

```typescript
// Get tools from MCP server
const tools = await client.getTools();

// Tools are already in v6 format with inputSchema
```

### Tool Execution

```typescript
// Tool results use 'output' (not 'result')
const toolResult = await client.executeTool({
  toolCallId: 'call_123',
  toolName: 'example_tool',
  input: { param: 'value' },  // 'input' not 'args'
});

// Response
interface ToolExecutionResult {
  toolCallId: string;
  output: unknown;  // 'output' not 'result'
}
```

## Stream Integration

### Writing Tool Results to Stream

```typescript
// v4 (deprecated)
import { formatDataStreamPart } from 'ai';
dataStream.write(
  formatDataStreamPart('tool_result', {
    toolCallId: 'call_123',
    result: { data: 'value' },
  })
);

// v6
writer.write({
  type: 'tool-result',
  toolCallId: 'call_123',
  output: { data: 'value' },  // 'output' not 'result'
});
```

## Transport Types

### Stdio Transport

```typescript
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';

const transport = new Experimental_StdioMCPTransport({
  command: string;
  args?: string[];
  env?: Record<string, string>;
});
```

### SSE Transport (if available)

```typescript
import { Experimental_SSEMCPTransport } from '@ai-sdk/mcp/mcp-sse';

const transport = new Experimental_SSEMCPTransport({
  url: string;
  headers?: Record<string, string>;
});
```

## Tool Approval Flow

The approval flow remains conceptually the same, but tool invocation parts use new property names:

```typescript
// Checking for tool calls in message parts
for (const part of message.content) {
  if (part.type === 'tool-call') {
    // v6: use 'input' instead of 'args'
    const { toolCallId, toolName, input } = part;

    // Request approval
    const approved = await requestUserApproval(toolName, input);

    if (approved) {
      const result = await executeMCPTool(toolCallId, toolName, input);

      // v6: write with 'output' instead of 'result'
      writer.write({
        type: 'tool-result',
        toolCallId,
        output: result,
      });
    }
  }
}
```

## Error Handling

```typescript
try {
  const client = await createMCPClient({ transport });
  // ... use client
} catch (error) {
  if (error.code === 'MCP_CONNECTION_FAILED') {
    // Handle connection failure
  }
  throw error;
} finally {
  await client.close();
}
```

## Affected Files

- `app/lib/services/mcpService.ts` - Complete migration to @ai-sdk/mcp
