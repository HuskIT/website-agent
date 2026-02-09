# AI SDK v6 Streaming Contract

## Overview

Defines the contract for the new v6 streaming protocol used in `app/routes/api.chat.ts`.

## v6 Streaming API

### Request

```typescript
// POST /api/chat
interface ChatRequest {
  messages: UIMessage[];
  model: string;
  provider: string;
  // ... other existing fields unchanged
}
```

### Response

```typescript
// SSE stream using createUIMessageStreamResponse
// Content-Type: text/event-stream

// Stream events:
interface UIMessageStreamEvent {
  type:
    | 'text'           // Text content chunk
    | 'tool-call'      // Tool invocation
    | 'tool-result'    // Tool result
    | 'data-progress'  // Custom progress data
    | 'error'          // Error event
    | 'finish';        // Stream complete
  data?: unknown;
}
```

## Stream Writer Methods

### v6 Writer API

```typescript
interface UIMessageStreamWriter {
  // Write structured event
  write(event: UIMessageStreamEvent): void;

  // Merge another stream
  merge(stream: UIMessageStream): void;

  // Write error
  error(error: Error): void;

  // Signal completion
  done(): void;
}
```

## Usage Patterns

### Progress Updates

```typescript
// v4 (deprecated)
dataStream.writeData({ type: 'progress', value: 50 });

// v6
writer.write({
  type: 'data-progress',
  data: { progress: 50 }
});
```

### Merging LLM Response

```typescript
// v4 (deprecated)
result.mergeIntoDataStream(dataStream);

// v6
writer.merge(result.toUIMessageStream());
```

### Error Handling

```typescript
// v4 (deprecated)
dataStream.writeData({ type: 'error', message: 'Failed' });

// v6
writer.write({
  type: 'error',
  data: { message: 'Failed' }
});
// or
writer.error(new Error('Failed'));
```

## Response Wrapper

```typescript
// v4 (deprecated)
return new Response(dataStream.toReadableStream(), {
  headers: { 'Content-Type': 'text/event-stream' }
});

// v6
return createUIMessageStreamResponse({ stream });
```

## Token Usage in Response

```typescript
// Included automatically in stream finish event
interface FinishEvent {
  type: 'finish';
  data: {
    usage: {
      inputTokens: number;
      outputTokens: number;
      inputTokenDetails?: {
        cacheReadTokens?: number;
      };
      outputTokenDetails?: {
        reasoningTokens?: number;
      };
    };
    finishReason: 'stop' | 'length' | 'tool-calls' | 'error';
  };
}
```
