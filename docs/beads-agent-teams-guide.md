# Parallel Beads Implementation with Claude Code Agent Teams

> **TL;DR**: Use Claude Code CLI Agent Teams as a "Beads graph executor" — the **lead agent** imports `bd ready` issues into the Team task list, **mirrors Beads deps as Team deps**, then delegates each leaf task to a specialist teammate. Enforce **plan approval**, **file-ownership announcements**, and a **single gatekeeper** (lead runs full gates before any `bd close`).

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [A. Architecture](#a-architecture)
- [B. Setup](#b-setup)
- [C. Workflow](#c-workflow)
- [D. Prompt Templates](#d-prompt-templates)
- [E. Safety](#e-safety)
- [F. Best Practices](#f-best-practices)

---

## Prerequisites

Before using Agent Teams for parallel Beads work:

1. **Beads must have tasks** — run `bd list --json`. If empty, populate first:
   ```bash
   # Option A: from speckit
   /speckit.taskstoissues

   # Option B: manual
   bd new --type task --title "T001: ..." --description "..."
   ```

2. **Claude Code CLI** — Agent Teams is a CLI feature (not VS Code Amp). Run `claude` from your terminal.

3. **tmux** (recommended for split-pane mode):
   ```bash
   brew install tmux
   ```

4. **At least 2-3 independent "ready" tasks** — Agent Teams adds overhead; don't use for sequential work.

---

## A. Architecture

### Mapping: Beads → Agent Team Tasks

| Beads Concept | Agent Team Equivalent |
|---|---|
| `bd-xxxx` issue | Team Task: `bd-xxxx — <title>` |
| `bd dep` dependency | Team Task dependency |
| `bd ready` (unblocked) | Task state: pending (claimable) |
| Issue `in_progress` | Task state: in_progress (claimed) |
| Issue closure | Task state: completed (**lead only**) |

### Dependency Mapping (1:1 + file-conflict ordering)

```
Beads: bd-A depends on bd-B  →  Team: Task A depends on Task B
```

**Add file-conflict deps** when two issues touch the same hotspot:
- Same route file (`app/routes/*.tsx`)
- Shared registries (`app/lib/**/index.ts`, provider registries)
- Shared types (`app/types/**`)
- Config files (`package.json`, `vite.config.*`)

### Task Classification

| Class | Description | Parallel? |
|---|---|---|
| **Foundation** | Shared types, schemas, registry wiring, config | ❌ Sequential first |
| **Feature leaf** | Isolated route/component/lib change | ✅ Safe to parallelize |
| **Integration** | Touches multiple layers | ❌ Keep sequential |

### Gatekeeper Model

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Teammate 1  │     │  Teammate 2  │     │  Teammate 3  │
│  (backend)   │     │  (frontend)  │     │  (verifier)  │
│              │     │              │     │              │
│ targeted     │     │ targeted     │     │ targeted     │
│ checks only  │     │ checks only  │     │ checks only  │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                    ┌───────▼───────┐
                    │   LEAD AGENT  │
                    │  (Gatekeeper) │
                    │               │
                    │ FULL GATES:   │
                    │ typecheck     │
                    │ lint          │
                    │ test          │
                    │ build         │
                    │               │
                    │ → bd close    │
                    └───────────────┘
```

---

## B. Setup

### 1. Enable Agent Teams

Open `~/.claude/settings.json` and add the env var manually (preserve your existing config):

```jsonc
{
  "env": {
    // ... your existing env vars stay here ...
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
  // ... rest of your config (permissions, model, plugins) unchanged ...
}
```

> ⚠️ Do NOT use automated jq scripts to merge — edit manually to avoid clobbering your existing `env`, `permissions`, `model`, and `enabledPlugins`.

### 2. Add Team Protocol to CLAUDE.md

Append to the end of your existing `CLAUDE.md`:

```markdown
## Agent Teams Protocol (Beads Parallel Implementation)

### Roles
- **Lead (Gatekeeper)**: imports bd graph → Team tasks, assigns work, approves plans, runs final gates, closes Beads issues.
- **Implementers**: implement assigned bd issue, run targeted checks, do NOT close issues or run `bd close`.
- **Verifier (optional)**: focuses on tests + edge/runtime constraints.

### Non-negotiables
1. **Plan approval required**: each teammate produces a plan (bd show + predicted files + test plan) before coding.
2. **File ownership**: before editing, announce file ownership in team messages. One file = one owner at a time.
3. **No `bd close` except Lead**.
4. **Final verification gates** run once by Lead before closing any issue:
   `pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run build`

### Conflict Avoidance
- Prefer isolated modules; avoid touching shared barrel exports unless necessary.
- If you must change a hotspot file, announce it and add dependency ordering.
```

### 3. Reuse Existing Agents (no new agents needed)

You already have well-defined agents in `.claude/agents/`. Map them to team roles:

| Team Role | Existing Agent | File |
|---|---|---|
| Backend implementer | `backend-architect` | `.claude/agents/backend-architect.md` |
| Frontend implementer | `frontend-developer` | `.claude/agents/frontend-developer.md` |
| Full-stack (when needed) | `fullstack-developer` | `.claude/agents/fullstack-developer.md` |
| Code review / verification | `code-reviewer` | `.claude/agents/code-reviewer.md` |
| Task breakdown | `task-decomposition-expert` | `.claude/agents/task-decomposition-expert.md` |

> **Note**: Valid tools for agent frontmatter: `Read, Write, Edit, Bash, Grep, Glob`. Your `code-reviewer` already uses `Grep`. Add `Grep, Glob` to implementer agents if you want them to search the codebase efficiently. The `mgrep` plugin is only available in the main session, not in teammates.

### 4. Configure tmux for Split-Pane Mode (optional)

Set in `~/.claude/settings.json`:

```json
{
  "teammateMode": "tmux"
}
```

Or pass per-session: `claude --teammate-mode tmux`

---

## C. Workflow

### Step-by-Step

```
┌──────────────────────────────────────────────────┐
│ 0. PREP: clean branch, bd ready --json           │
│    (must have tasks — populate first if empty)    │
├──────────────────────────────────────────────────┤
│ 1. START: `claude` in tmux, request agent team   │
├──────────────────────────────────────────────────┤
│ 2. IMPORT: lead creates Team tasks from bd ready │
│    - mirrors Beads deps + adds file-conflict deps│
├──────────────────────────────────────────────────┤
│ 3. PLAN: each teammate runs `bd show <id> --json`│
│    and produces a plan. Lead approves/revises.   │
├──────────────────────────────────────────────────┤
│ 4. IMPLEMENT: teammates work in parallel         │
│    - each runs targeted checks (typecheck only)  │
│    - announces file ownership via messages        │
├──────────────────────────────────────────────────┤
│ 5. INTEGRATE: lead runs full gates               │
│    - typecheck → lint → test → build             │
│    - bd close for each passing issue             │
├──────────────────────────────────────────────────┤
│ 6. REPEAT: bd ready --json → next batch          │
└──────────────────────────────────────────────────┘
```

### Detailed Steps

#### 0. Prep (once per batch)
```bash
git checkout main && git pull
git checkout -b beads/batch-$(date +%Y%m%d)
bd list --json > /tmp/beads-snapshot-$(date +%Y%m%d-%H%M%S).json
bd ready --json   # must return tasks — if empty, populate first
```

#### 1. Start Agent Team (in Claude Code CLI)
```bash
# Start tmux
tmux new -s beads

# Launch Claude Code CLI
cd /path/to/website-agent
claude
```

Then prompt:
```
Create an agent team for parallel Beads implementation.
Use 2 implementer teammates. I'll use delegate mode.
```

Press **Shift+Tab** to activate delegate mode (lead coordinates only, no coding).

#### 2. Import Tasks
The lead runs `bd ready --json` and `bd show <id> --json` for each, then creates Team tasks with dependencies.

#### 3. Plan Phase (no slash commands — use explicit instructions)

> **Important**: Teammates are independent Claude Code sessions. They load `CLAUDE.md` and agents, but do NOT have access to `/implement-beads` slash commands. Use explicit instructions instead.

Lead delegates to each teammate with full context:
```
Run `bd show <ID> --json` and read the issue.
Then produce a plan:
1. List the files you will change
2. List the files you will NOT touch (ownership boundary)
3. Describe the implementation approach
4. Describe what tests you will run
Wait for my approval before writing any code.
```

#### 4. Parallel Implementation
After plan approval, teammates implement and run targeted checks:
```bash
pnpm run typecheck                    # always
pnpm exec vitest run <relevant-test>  # if applicable
```

Each teammate commits with: `git commit -am "bd-xxxx: <short description>"`

#### 5. Final Gates (Lead Only)
```bash
pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run build
```

If all pass, lead runs:
```bash
bd update "<ID>" --append-notes "Implementation complete. Gates: all pass."
bd close "<ID>" --reason "Implemented per AC. Verified: typecheck, lint, test, build."
```

#### 6. Next Batch
```bash
bd ready --json
```

---

## D. Prompt Templates

### Lead Kickoff Prompt

```
You are the Team Lead for parallel Beads implementation in this Remix 2.15 + Vite + TS + Cloudflare Pages repo.
Read CLAUDE.md for architecture and team protocol.

Steps:
1) Run `bd ready --json` and select 2-4 issues that are ready (no unmet deps).
2) For each issue, run `bd show <id> --json`. Extract: deps, scope, mentioned files, spec dir.
3) Create Team tasks: one per Beads issue. Mirror Beads deps as Team deps.
4) Add extra ordering constraints if two tasks likely touch the same files.
5) Spawn 2 teammates and delegate leaf tasks.
6) For each teammate: send them the full `bd show` output and ask for a plan BEFORE implementation.
7) Only you run full repo gates (typecheck, lint, test, build) and `bd close`.

Output a "Batch Manifest" table: task ID, title, assigned teammate, predicted files, risk.
```

### Delegate Prompt (sent by lead to each teammate)

```
Implement Beads issue. Here is the issue:

<paste bd show output here>

Hard rules (from CLAUDE.md):
- Do NOT run `bd close` — only the lead does that.
- Do NOT edit files outside your ownership boundary.

Phase 1 — Plan (do this first, wait for approval):
1) Read the issue description and any referenced spec files.
2) List files you will create/modify.
3) List files you will NOT touch.
4) Describe your implementation approach.
5) Describe what tests you will add/run.

Phase 2 — Implement (only after lead approves your plan):
1) Implement the changes.
2) Run `pnpm run typecheck` and fix any errors.
3) Run relevant tests: `pnpm exec vitest run <path>`.
4) Commit: `git commit -am "bd-XXXX: <short>"`.
5) Report back: files changed, check results, any issues.
```

### Lead Approval Rubric

```
Review the teammate's plan. Decide: APPROVE / REVISE / BLOCK.

APPROVE if:
- Predicted files don't overlap with other in-progress teammates
- Test plan exists
- Remix server/client boundaries (.server.ts) respected
- No Node-only APIs in edge runtime code

REVISE if:
- File overlap detected → add ordering or reassign
- Missing test plan → ask them to add one

BLOCK if:
- Task depends on unfinished work
- Would require editing hotspot files already owned by another teammate
```

### Final Closure Prompt (lead)

```
All teammates have reported completion.
1) Check working tree: `git status`
2) Run full gates:
   pnpm run typecheck
   pnpm run lint
   pnpm run test
   pnpm run build
3) If ALL pass: for each completed Beads issue run:
   bd update "<id>" --append-notes "Implementation complete. All gates pass."
   bd close "<id>" --reason "Implemented. Verified: typecheck, lint, test, build all pass."
4) If ANY gate fails: do NOT close. Triage and assign fixes.
```

---

## E. Safety

### File Conflict Prevention

| Strategy | How |
|---|---|
| **Predicted Files** | Each teammate lists files during plan phase |
| **Ownership Announcement** | Lead assigns file areas; one owner per hotspot |
| **Dependency Ordering** | Add Team deps when overlap detected |
| **Edit Contract** | Teammate A refactors file first, Teammate B consumes after |

### Verification Strategy (cost-effective)

| Who | What | When |
|---|---|---|
| Each teammate | `pnpm run typecheck` + `vitest run <path>` | After implementation |
| Lead only | Full: typecheck + lint + test + build | Before `bd close` |

> Running full gates in every teammate wastes ~4× tokens and time. Targeted checks catch most issues; the lead's full run catches integration problems.

### Rollback

- **Small commits per task**: `git commit -am "bd-xxxx: <short>"`
- **Quick discard**: `git restore -SW .`  (unstaged + staged)
- **After integration**: `git revert <commit>`
- **Beads**: keep issue `in_progress` if reverted; add notes explaining why

---

## F. Best Practices

### ✅ Do

- Start with **2-3 agents total** (1 lead + 1-2 implementers)
- Use **delegate mode** (Shift+Tab) for the lead
- Require **plan approval** before any code is written
- Use **tmux split-pane** mode for visibility
- Start with **1-2 tasks per teammate** per batch (scale up after smooth runs)
- Reuse your **existing agents** (`backend-architect`, `frontend-developer`, `code-reviewer`)
- Have each teammate **commit per task** for easy revert

### ❌ Don't

- Parallelize tasks that share a route file
- Let teammates run `bd close`
- Skip the plan phase
- Run full `pnpm run test && build` in every teammate (expensive + redundant)
- Parallelize: package.json changes, build config, shared type rewrites
- Let the team run unmonitored for extended periods
- Create duplicate agents — reuse existing `.claude/agents/*`

### When to Keep Sequential (use single `/implement-beads` instead)

- Large refactors / architecture changes
- `package.json` / lockfile / dependency changes
- Build tooling / Vite / Remix config changes
- Shared type rewrites across many files
- Cross-cutting runtime behavior (Cloudflare Pages env/bindings)
- Tasks with >3 dependency hops

### Optimal tmux Layout

```
┌─────────────────┬─────────────────┐
│   Lead Agent    │  Teammate 1     │
│   (gatekeeper)  │  (backend)      │
│   delegate mode │                 │
├─────────────────┼─────────────────┤
│  Teammate 2     │   Terminal      │
│  (frontend)     │   (git/gates)   │
│                 │                 │
└─────────────────┴─────────────────┘
```

Use `Shift+Up/Down` in in-process mode to switch between teammates.
Click into panes in split-pane mode.
Press `Ctrl+T` to toggle the task list.

### Comparison: 3 Approaches to Beads

| Approach | Best For | Token Cost | When to Use |
|---|---|---|---|
| **Single session** `/implement-beads <id>` | Sequential, dependent tasks | 1× | Default — most tasks |
| **Subagents** (within one session) | Independent research/review | ~4× | Exploration, code review |
| **Agent Teams** (multiple sessions) | 3+ truly independent leaf tasks | ~15× | Large parallel batches |

---

## Quick Start Checklist

```
□ 1. Beads has tasks: bd list --json (not empty)
□ 2. Enable Agent Teams: add CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
       to env in ~/.claude/settings.json (edit manually)
□ 3. tmux installed: brew install tmux
□ 4. Start: tmux new -s beads → cd project → claude
□ 5. Prompt: "Create an agent team for parallel Beads implementation"
□ 6. Shift+Tab → delegate mode
□ 7. Lead runs: bd ready --json → creates Team tasks
□ 8. Teammates plan → lead approves → teammates implement
□ 9. Lead runs full gates → bd close
```
