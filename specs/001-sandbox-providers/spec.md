# Feature Specification: Multi-Sandbox Provider Support

**Feature Branch**: `001-sandbox-providers`
**Created**: 2026-02-04
**Status**: Implementation In Progress (MVP ~94% complete)
**Last Updated**: 2026-02-05
**Input**: User description: "Add Vercel Sandbox as alternative to WebContainer for build and preview with provider abstraction layer to support multiple sandbox providers"

## Implementation Status

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1: Setup | ✅ Complete | Dependencies, migration, env vars |
| Phase 2: Foundational | ✅ Complete | SandboxProvider interface, types, stores |
| Phase 3: US1 Fast Preview | ✅ Complete | API routes, providers, ActionRunner refactor |
| Phase 4: US2 Session Persistence | ✅ Complete | Reconnect, timeout manager, warnings |
| Phase 5: US3 Provider Config | ✅ Complete | Settings UI, env-based config |
| Phase 6: US4 Resource Usage | ✅ Complete | Cloud execution, telemetry |
| Phase 7: US5 Snapshots | 🟡 Partial | Create/restore placeholder, **auto-snapshot on warning/timeout implemented** |
| Phase 8: Polish | ✅ Complete | Error handling, logging, feature flags |

## Problem Statement

The current in-browser code execution environment has significant reliability and performance issues that impact user experience:

1. **Unreliable execution**: Commands take excessive time to complete, and results are inconsistent
2. **Session persistence**: Browser refresh (F5) resets the entire workspace, losing all state
3. **Heavy resource usage**: High CPU and RAM consumption causes local machine lag and slowdowns
4. **Long wait times**: Build and preview processes are slow, frustrating users who expect instant feedback
5. **Demonstration impact**: These issues create poor impressions during user demonstrations

Users need changes to reflect in the live preview as fast as possible when they prompt modifications. The current single-provider approach limits options for addressing these issues.

## Proposed Solution

Implement a provider abstraction layer that allows the system to use different sandbox providers for code execution and preview. This enables:

- Using cloud-based execution (Vercel Sandbox) to offload resource usage
- Maintaining session state across browser refreshes
- Leveraging snapshots to dramatically reduce build times
- Providing flexibility to add future sandbox providers
- Giving users choice based on their needs (speed vs. offline capability)

## Clarifications

### Session 2026-02-04

- Q: Should the cloud sandbox provider replace WebContainer entirely when selected, or run alongside the existing persistence tiers? → A: **Replace** - Cloud provider replaces WebContainer as Tier 1. Files live in Vercel Sandbox FS, not WebContainer. Nanostores syncs FROM cloud provider. Snapshots continue to save to IndexedDB/Supabase as backup for both modes.
- Q: How should Vercel Sandbox sessions relate to projects? → A: **On-demand with reconnect** - Create sandbox when project opens, store `sandboxId` on project. Reconnect if still active, otherwise create new from Supabase snapshot. Auto-snapshot on disconnect to preserve work.
- Q: How should Vercel Sandbox authentication be handled? → A: **Platform-managed** - Single Vercel team/project owned by HuskIT. All users share the platform's quota. Credentials stored as server-side environment variables, never exposed to client.
- Q: What should be the default sandbox provider for new projects? → A: **Vercel Sandbox default** - New projects use cloud provider by default for best performance. Users can switch to WebContainer (local) via settings if offline capability is needed.
- Q: How should the system handle Vercel Sandbox timeout management? → A: **Activity-based** - Extend timeout only when user is actively editing (keystroke/save within last 5 min). Idle sessions timeout naturally. Auto-snapshot triggered before timeout to preserve work.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fast Preview Updates (Priority: P1)

As a user editing a website, I want my changes to appear in the live preview as quickly as possible so I can see the results of my prompts without waiting.

**Why this priority**: This is the core value proposition. Users are frustrated by slow feedback loops, and fast preview is essential for a productive editing experience.

**Independent Test**: Can be fully tested by making a text change to a component and measuring the time until the preview reflects that change. Delivers immediate user value by reducing wait time.

**Acceptance Scenarios**:

1. **Given** a project is open with an active preview, **When** the user modifies a file through a prompt, **Then** the preview updates to show the change within 5 seconds
2. **Given** a project uses a cloud-based provider, **When** a file is modified, **Then** only the changed files are synchronized (not the entire project)
3. **Given** a large project with many files, **When** a single file changes, **Then** the incremental update completes faster than a full rebuild

---

### User Story 2 - Session Persistence (Priority: P1)

As a user, I want my workspace state to survive browser refreshes so I don't lose my work or have to wait for a full rebuild.

**Why this priority**: Session loss on refresh is a critical pain point that causes data loss and wasted time. Essential for usability.

**Independent Test**: Can be tested by opening a project, making changes, refreshing the browser (F5), and verifying the workspace restores to the same state. Delivers reliability value.

**Acceptance Scenarios**:

1. **Given** a user has a project open with unsaved changes, **When** they refresh the browser, **Then** the workspace restores to the previous state within 3 seconds
2. **Given** a build was in progress, **When** the browser is refreshed, **Then** the system resumes from the last known good state rather than starting from scratch
3. **Given** a cloud-based provider is selected, **When** the user returns to a project after closing the tab, **Then** they can reconnect to the existing session if it's still active

---

### User Story 3 - Provider Selection (Priority: P2)

As a user, I want to choose which execution provider to use so I can balance speed, reliability, and offline capability based on my situation.

**Why this priority**: Provider choice enables users to optimize for their specific needs (demo mode vs. offline development).

**Independent Test**: Can be tested by selecting different providers in settings and verifying each provider successfully runs a simple project. Delivers flexibility value.

**Acceptance Scenarios**:

1. **Given** multiple providers are available, **When** the user opens provider settings, **Then** they see a list of available providers with status indicators
2. **Given** a provider is selected, **When** the user starts a new project, **Then** that provider is used for code execution
3. **Given** the selected provider is unavailable, **When** the user attempts to run code, **Then** they receive a clear error message with suggestions to try another provider

---

### User Story 4 - Reduced Local Resource Usage (Priority: P2)

As a user with a less powerful computer, I want the option to offload code execution to the cloud so my machine doesn't lag or overheat.

**Why this priority**: Heavy local resource usage prevents users with modest hardware from having a good experience.

**Independent Test**: Can be tested by monitoring CPU and RAM usage while running a project with cloud provider vs. local provider. Delivers accessibility value for users with limited hardware.

**Acceptance Scenarios**:

1. **Given** a cloud-based provider is selected, **When** code execution runs, **Then** local CPU usage remains below 30% during builds
2. **Given** a cloud-based provider is selected, **When** the preview is active, **Then** the local browser memory footprint is reduced compared to in-browser execution
3. **Given** heavy build processes run remotely, **When** the user continues editing, **Then** the UI remains responsive without stuttering

---

### User Story 5 - Snapshot-Based Fast Starts (Priority: P3)

As a user returning to a project, I want to skip the dependency installation phase by resuming from a saved snapshot so I can start working immediately.

**Why this priority**: Build time optimization is important but depends on the core provider infrastructure being in place first.

**Independent Test**: Can be tested by creating a snapshot after installing dependencies, then starting a new session from that snapshot and measuring startup time. Delivers time-saving value.

**Acceptance Scenarios**:

1. **Given** a project has been built previously, **When** the user reopens it with a snapshot-capable provider, **Then** the workspace is ready in under 10 seconds (vs. 60+ seconds for fresh install)
2. **Given** a snapshot exists, **When** the user makes file changes and creates a new snapshot, **Then** only incremental changes are saved
3. **Given** a snapshot is older than 7 days, **When** the system attempts to use it, **Then** a new build is triggered automatically with a notification to the user

---

### Edge Cases

- What happens when the selected cloud provider has an outage?
  - System should detect unavailability and offer to switch to an alternative provider
- How does the system handle network disconnection during cloud execution?
  - Reconnection should resume the session if the sandbox is still active; otherwise, offer local fallback
- What happens when a user exceeds their cloud provider quota?
  - Clear messaging about quota limits with option to continue locally
- How does the system handle concurrent edits during file sync?
  - Most recent change wins with conflict detection for significant differences
- What happens if snapshot creation fails mid-process?
  - The incomplete snapshot is discarded; the previous valid snapshot remains available
- What happens when cloud sandbox times out while user is away?
  - Auto-snapshot is triggered before timeout. When user returns, system creates new sandbox from snapshot with notification "Session restored from snapshot"

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide an abstraction layer that supports multiple sandbox providers
- **FR-002**: System MUST support at least two providers: in-browser execution and cloud-based execution
- **FR-003**: Users MUST be able to select their preferred provider from available options
- **FR-004**: System MUST synchronize file changes to the active provider incrementally (changed files only)
- **FR-005**: System MUST persist workspace state in a way that survives browser refresh
- **FR-006**: System MUST support snapshot creation and restoration for fast project starts
- **FR-007**: System MUST display provider status (connected, loading, error) clearly to users
- **FR-008**: System MUST handle provider failures gracefully with clear error messages
- **FR-009**: System MUST expose a preview URL that users can view and optionally share
- **FR-010**: System MUST support running shell commands in the sandbox environment
- **FR-011**: System MUST stream command output (stdout/stderr) to the terminal in real-time
- **FR-012**: System MUST allow preinstalled packages in snapshots to reduce build times
- **FR-013**: System MUST store active cloud sandbox session ID on the project record to enable reconnection
- **FR-014**: System MUST auto-save snapshot when cloud sandbox session disconnects or times out
- **FR-015**: System MUST default to cloud provider (Vercel Sandbox) for new projects
- **FR-016**: System MUST allow users to change their preferred provider in settings, persisted per-user
- **FR-017**: System MUST extend cloud sandbox timeout only when user activity is detected (edit/save within 5 minutes)
- **FR-018**: System MUST warn users when cloud sandbox timeout is approaching (e.g., 2 minutes before expiry)
- **FR-019**: System MUST trigger auto-snapshot before cloud sandbox timeout expires

### Key Entities

- **Sandbox Provider**: A service that executes code and provides preview capability. Has a type (local/cloud), connection status, and configuration. When active, the provider's filesystem is authoritative (Tier 1) - WebContainer for local mode, Vercel Sandbox FS for cloud mode.
- **Workspace Session**: The current state of a user's project in a sandbox. Includes files, running processes, and environment state. Session data syncs FROM the active provider TO Nanostores for UI reactivity. For cloud providers, the `sandboxId` is stored on the project record to enable reconnection. Sessions are created on-demand and auto-snapshot on disconnect.
- **Snapshot**: A saved state of a workspace that can be restored. Contains filesystem state, installed packages, and environment configuration. Snapshots save to IndexedDB (Tier 2) and Supabase (Tier 3) regardless of which provider is active.
- **Preview**: A live-updating view of the running application. Has a URL and connection state. URL source depends on provider (WebContainer port proxy vs. Vercel Sandbox domain).
- **File Sync State**: Tracks which files have been synchronized to the provider and which have pending changes. Direction is always Editor → Active Provider → Nanostores.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users see preview updates within 5 seconds of a file change for 95% of edits
- **SC-002**: Workspace restoration after browser refresh completes in under 3 seconds for 95% of sessions
- **SC-003**: Projects with existing snapshots become ready-to-edit in under 10 seconds (vs. 60+ seconds baseline)
- **SC-004**: Local CPU usage stays below 30% when using cloud-based execution for build processes
- **SC-005**: 90% of users successfully complete a preview session without encountering provider failures
- **SC-006**: Provider switching requires fewer than 3 clicks from any project view
- **SC-007**: System achieves 99% session persistence rate (sessions surviving browser refresh)

## Scope

### In Scope

- Provider abstraction layer architecture
- In-browser execution provider (current capability, refactored)
- Cloud-based execution provider integration
- Provider selection UI in settings
- File synchronization between editor and provider
- Session persistence mechanism
- Snapshot save and restore functionality
- Preview URL generation and display
- Terminal command execution with streaming output
- Provider status indicators
- Error handling and fallback behavior

### Out of Scope

- Billing and quota management for cloud providers (handled by provider accounts)
- Custom provider plugin system (future consideration)
- Multi-user collaborative editing within a single sandbox
- Offline-first with sync when online (different architecture)
- Mobile device optimization

## Assumptions

- Users have stable internet connectivity when using cloud-based providers
- Cloud provider APIs remain stable and backward-compatible
- Browser storage (IndexedDB/localStorage) is available and not cleared by user
- Users are authenticated and have valid cloud provider credentials when using cloud features
- File changes are sequential (not concurrent multi-user editing)
- Project sizes are within reasonable limits (under 500MB total)
- The current in-browser execution capability can be refactored without breaking existing functionality

## Dependencies

- Cloud sandbox provider account and API access (platform-managed Vercel team/project)
- Vercel authentication tokens stored as server-side environment variables (`VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `VERCEL_TOKEN`)
- Browser support for required APIs (SharedArrayBuffer for in-browser, standard fetch for cloud)
- Existing file system and editor state management
- Server-side API routes to proxy all Vercel Sandbox operations (credentials never sent to client)
