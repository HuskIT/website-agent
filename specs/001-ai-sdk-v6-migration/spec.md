# Feature Specification: Vercel AI SDK v6 Migration

**Feature Branch**: `001-ai-sdk-v6-migration`
**Created**: 2026-02-05
**Status**: Draft
**Input**: User description: "Implement the AI SDK v6 migration plan documented in docs/ai-sdk-v6-migration-plan.md"

## Overview

Migrate the website-agent codebase from Vercel AI SDK v4.3.16 to v6.0.70, updating all provider packages, streaming protocols, message types, tool definitions, and MCP integration to use the new v6 APIs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Basic Chat Continues Working (Priority: P1)

As a user, I can continue having conversations with the AI assistant after the migration, with the same quality of experience as before.

**Why this priority**: This is the core functionality - if chat doesn't work, nothing works. All restaurant website generation depends on functional AI chat.

**Independent Test**: Can be fully tested by starting a new chat, sending a message, and receiving a streaming response. Delivers the fundamental value of AI-powered conversation.

**Acceptance Scenarios**:

1. **Given** a user is on the chat interface, **When** they send a message, **Then** they receive a streaming response from the AI that appears progressively
2. **Given** a user has an ongoing conversation, **When** they send a follow-up message, **Then** the AI responds with context from previous messages
3. **Given** a user selects any supported LLM provider (OpenAI, Anthropic, Google, etc.), **When** they send a message, **Then** the system routes to the correct provider and returns a response

---

### User Story 2 - Tool Calling Functions Correctly (Priority: P1)

As a user, I can use AI features that require tool calling (like info collection, code execution), and they work seamlessly.

**Why this priority**: Tool calling enables the info collection agent and all interactive AI features. Critical for restaurant data gathering workflow.

**Independent Test**: Can be tested by triggering the info collection flow where the AI uses tools to gather restaurant information.

**Acceptance Scenarios**:

1. **Given** the AI determines it needs to use a tool, **When** the tool call is made, **Then** the tool executes with correct parameters and returns results
2. **Given** a tool returns a result, **When** the AI processes it, **Then** the response incorporates the tool output correctly
3. **Given** multiple tools are defined in the system, **When** the AI selects a tool, **Then** it uses the correct schema format (inputSchema)

---

### User Story 3 - MCP Tools Work with Approval Flow (Priority: P1)

As a user, I can use MCP (Model Context Protocol) tools, and the tool approval flow works correctly.

**Why this priority**: MCP integration enables extensible AI capabilities and third-party tool integration. Essential for advanced features.

**Independent Test**: Can be tested by configuring an MCP server, triggering a tool that requires approval, and completing the approval flow.

**Acceptance Scenarios**:

1. **Given** an MCP server is configured, **When** the AI invokes an MCP tool, **Then** the tool executes via the new @ai-sdk/mcp package
2. **Given** an MCP tool requires approval, **When** the approval request is shown, **Then** the user can approve or deny, and the flow completes correctly
3. **Given** an MCP tool execution completes, **When** the result is returned, **Then** it integrates properly into the AI response stream

---

### User Story 4 - Message Persistence Works (Priority: P2)

As a user, my conversation history is saved and can be restored when I return to a project.

**Why this priority**: Users expect their work to persist. Loss of conversation history would be a major regression.

**Independent Test**: Can be tested by having a conversation, navigating away, and returning to verify messages are preserved.

**Acceptance Scenarios**:

1. **Given** a user has a conversation, **When** they leave and return to the project, **Then** all messages are restored correctly
2. **Given** messages contain tool invocations, **When** they are saved and restored, **Then** the tool call data (inputs/outputs) is preserved
3. **Given** the message format changed in v6, **When** loading existing v4 messages, **Then** they display correctly (backward compatibility)

---

### User Story 5 - Stream Continuation Works (Priority: P2)

As a user, when the AI response hits token limits, the system automatically continues the response.

**Why this priority**: Long responses (like generating website code) often exceed token limits. Automatic continuation is essential for code generation workflows.

**Independent Test**: Can be tested by requesting a very long response that exceeds the model's token limit and verifying automatic continuation.

**Acceptance Scenarios**:

1. **Given** an AI response reaches token limit (finishReason === 'length'), **When** the limit is detected, **Then** the system automatically continues the response
2. **Given** continuation occurs, **When** the continued response arrives, **Then** it seamlessly merges with the previous response

---

### User Story 6 - Token Usage Displays Correctly (Priority: P3)

As a user, I can see accurate token usage information for my conversations.

**Why this priority**: Token usage affects costs and helps users understand model consumption. Nice-to-have but not critical.

**Independent Test**: Can be tested by sending a message and verifying the token count displays correctly in the UI.

**Acceptance Scenarios**:

1. **Given** a message is sent, **When** the response completes, **Then** the token usage displays with correct input/output token counts
2. **Given** the usage object structure changed in v6, **When** displaying usage, **Then** the new property names (inputTokens, outputTokens) are used

---

### Edge Cases

- When a v4 message format is loaded after migration, the system silently auto-transforms it to v6 format on load (no user action required)
- How does the system handle if an MCP server connection fails during a tool call?
- What happens if the streaming protocol version mismatches between client and server?
- How are in-flight requests handled during deployment transition?

## Requirements *(mandatory)*

### Functional Requirements

**Core Streaming (Critical)**
- **FR-001**: System MUST use the new streaming protocol (createUIMessageStream instead of createDataStream)
- **FR-002**: System MUST correctly format progress updates using the new stream writer API
- **FR-003**: System MUST merge AI responses into the stream using toUIMessageStream()
- **FR-004**: System MUST handle stream responses with createUIMessageStreamResponse

**Message Handling (Critical)**
- **FR-005**: System MUST convert UI messages to model messages using convertToModelMessages (async)
- **FR-006**: System MUST use the new message type structure (ModelMessage instead of CoreMessage)
- **FR-007**: System MUST handle tool invocation parts with new property names (input/output instead of args/result)

**Tool Definitions (Critical)**
- **FR-008**: System MUST define tool schemas using inputSchema (not parameters)
- **FR-009**: System MUST support outputSchema where beneficial for structured tool responses

**MCP Integration (Critical)**
- **FR-010**: System MUST use @ai-sdk/mcp package instead of experimental_createMCPClient from 'ai'
- **FR-011**: System MUST use createMCPClient from the new package
- **FR-012**: System MUST use Experimental_StdioMCPTransport from @ai-sdk/mcp/mcp-stdio

**Provider Types (Major)**
- **FR-013**: System MUST use LanguageModelV3 type (or generic LanguageModel) instead of LanguageModelV1
- **FR-014**: All 20+ provider files MUST be updated to use the new type

**Token Usage (Minor)**
- **FR-015**: System MUST read token usage from new property structure (inputTokens, outputTokens, inputTokenDetails, outputTokenDetails)

**Backward Compatibility**
- **FR-016**: System MUST silently auto-transform v4 message formats to v6 format on load (no user action required)
- **FR-017**: System MUST run official codemods (npx @ai-sdk/codemod v6) as part of migration

### Key Entities

- **UIMessage**: Represents messages in the UI layer, converted to ModelMessage for LLM calls
- **ModelMessage**: New v6 message type replacing CoreMessage for model interactions
- **ToolDefinition**: Tool configuration with inputSchema/outputSchema properties
- **MCPClient**: Model Context Protocol client for external tool integration
- **StreamWriter**: New v6 abstraction for writing to UI message streams

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All existing chat functionality works identically from user perspective after migration
- **SC-002**: TypeScript compilation passes with zero errors (pnpm typecheck succeeds)
- **SC-003**: All existing tests pass (pnpm test succeeds)
- **SC-004**: Top 3 LLM providers (OpenAI, Anthropic, Google) require explicit manual integration testing; other providers verified via automated tests
- **SC-005**: MCP tool configuration and execution works with existing MCP servers
- **SC-006**: Stream continuation works for responses exceeding token limits
- **SC-007**: Messages persist and restore correctly across sessions
- **SC-008**: No user-facing regressions in chat, tool calling, or code generation workflows
- **SC-009**: Official codemods execute successfully as part of migration

## Clarifications

### Session 2026-02-05

- Q: How should the migration be deployed? → A: Big-bang migration (single cutover, no parallel code paths)
- Q: How should existing v4 messages be handled after migration? → A: Silent conversion (auto-transform v4 → v6 format on load)
- Q: Which providers require explicit manual integration testing? → A: Top 3 by usage (OpenAI, Anthropic, Google)

## Assumptions

- The official AI SDK codemods will handle most mechanical type/import changes automatically
- Community providers (@openrouter/ai-sdk-provider, ollama-ai-provider) will have compatible v6 versions available
- Existing persisted messages in Supabase can be read with the new message types (or require no schema changes at persistence layer)
- The streaming protocol changes are backward compatible at the network/SSE level with existing client code
- Migration will use big-bang approach with single cutover (no feature flags or parallel code paths)

## Out of Scope

- Performance optimizations beyond maintaining current performance levels
- New features or capabilities beyond what v6 enables by default
- Database migrations for message format changes (handled at application layer if needed)
- Updating documentation beyond inline code comments
