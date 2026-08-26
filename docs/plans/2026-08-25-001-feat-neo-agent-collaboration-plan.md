---
date: 2026-08-25
type: feat
status: active
topic: neo-agent-collaboration-orchestrator
origin: docs/brainstorms/2026-08-25-neo-agent-collaboration-requirements.md
---

# feat: Build Neo AI Collaboration Orchestrator

## Problem Frame

Neo needs to turn the agreed product behavior into a Pi extension that coordinates Profiles, global declarative Workflows, dynamic Skills, subagents, Goals, Todos, Shell actions, approvals, and durable run history through one `/neo` command namespace.

The implementation must preserve Agent autonomy. Workflows provide an initial route, but a run may add, skip, split, merge, reorder, or branch steps. Missing Skills and missing specialist subagents are recoverable guidance gaps, not ordinary task failures. High-risk external actions still require explicit user confirmation.

The MVP should give Neo its own Native Runtime built on Pi's public SDK. `example/pi-subagents`, `example/tintinweb-pi-subagents`, and `example/pi-tasks` are design references only; Neo must not require either subagent manager to execute its own child sessions.

This plan is directional guidance for implementation. The implementing agent should validate exact package types and host APIs before coding.

## Requirements Traceability

The implementation units below cover the origin requirements in `docs/brainstorms/2026-08-25-neo-agent-collaboration-requirements.md`:

- `/neo` command surface and dashboard: R1-R3, R21-R22
- Profile and temporary execution context: R4-R6
- Dynamic Skill and subagent selection: R7-R10
- Declarative and adaptive Workflow execution: R11-R16
- Goal, Todo, evidence, and history: R17-R20
- End-to-end acceptance behavior: AE1-AE7

## Technical Direction

### Native Runtime Boundary

Neo owns child-session execution through the public Pi SDK rather than delegating execution to another subagent extension. The Native Runtime should use:

- `createAgentSession()` for each child session.
- `AgentSession.prompt()`, `steer()`, `followUp()`, `abort()`, `compact()`, `subscribe()`, and `dispose()` for lifecycle and control.
- `SessionManager` for in-memory, persistent, open, and resumed child sessions.
- A shared `ModelRuntime` for model resolution and credentials, with per-agent model/thinking selection.
- `DefaultResourceLoader` or a custom `ResourceLoader` with explicit `skillsOverride`, `agentsFilesOverride`, `extensionFactories`, system prompt, cwd, and tool selection.
- Pi's `defineTool()`/custom tool contract for Neo coordination tools exposed to children.

Neo's internal `NativeAgentRuntime` contract should expose stable `spawn`, `prompt`, `steer`, `followUp`, `stop`, `resume`, `status`, and `dispose` operations. It owns concurrency, child records, event normalization, usage collection, session leases, and recovery mapping from `(neoRunId, nodeId, attemptId)` to a child session.

Child sessions must not use the ambient default resource discovery by accident. The runtime should explicitly control which extensions, Skills, context files, and tools are loaded, and should exclude Neo itself, `pi-subagents`, `tintinweb-pi-subagents`, and `pi-tasks` unless a future Profile explicitly requests a safe integration. This prevents recursive managers, duplicate commands, and cross-session state leakage. Same-process execution is acceptable for the MVP; OS process isolation remains a later option for stronger containment.

`example/pi-subagents` remains a reference for delegation identity, child safety, structured output, capability ceilings, and recovery. `example/tintinweb-pi-subagents` remains a reference for Agent UX, mentions, lifecycle display, and steering. `example/pi-tasks` remains a reference for generic task persistence, dependency edges, locking, reminders, and widgets. Do not import any of their private `src/**` runtime internals.

### Neo-Owned State

Neo owns the product state for Profile, Goal, Todo projection, Workflow definition, Workflow Run, node attempts, dynamic graph revisions, approvals, artifacts, receipts, and audit events. Use an append-only event log plus materialized snapshots so recovery can rebuild state and inspect the plan-versus-actual history.

Neo's Native Runtime child-session IDs, session files, and runtime artifacts are linked evidence, not the sole source of truth. A node attempt must retain its child session reference and terminal status. If an external side effect is ambiguous after a crash, the node enters an explicit unknown-effect/blocked state rather than blindly rerunning.

`pi-tasks` demonstrates useful generic Todo behavior, but Neo's Todo is a projection of the mutable Workflow Run and must retain node IDs, graph revisions, attempts, evidence, and Goal links. Keep Neo's domain state separate until a documented cross-extension projection API is available.

### Workflow Representation

Use a global declarative YAML Workflow format for the MVP. A Workflow declares its initial graph, inputs, suggested Skills and Agents, Shell commands, risk metadata, approval points, outputs, and success criteria. YAML parsing and semantic validation occur before a run is created.

The runtime graph is a mutable per-run copy of the initial graph. Every mutation uses a stable node ID and a monotonic graph revision. Mutations are accepted only through Neo's domain service, then atomically recorded before newly-ready nodes are scheduled.

Supported MVP node kinds:

- `agent`: call a configured Agent with task context and optional structured output schema.
- `shell`: run an arbitrary project command through the Pi host execution API with cwd, environment references, timeout, output capture, and risk metadata.
- `approval`: pause until the user approves or rejects a specific run/node/command/version.
- `condition`: evaluate structured state deterministically; natural-language guesses do not control graph transitions.
- `parallel`: schedule independent child nodes with bounded concurrency and explicit join behavior.
- `artifact`: register a durable report, patch, log, or generated file.
- `receipt`: register an external outcome such as deployment, CI, release, or health verification.

Retry, timeout, resume, and rollback are node policies or domain operations, not separate graph node kinds in the MVP.

### Soft Autonomy and Safety

Workflow `recommendedSkills` and `discoverScopes` are guidance. Agent nodes may search/load Skills, continue with model knowledge when discovery is empty, and select or skip specialist subagents. The Native Runtime should record selected Skill names and provenance when available, but must not make an unavailable optional Skill fatal.

Tool access remains a runtime capability, not a Skill consequence. Shell nodes may execute arbitrary commands, but high-risk nodes require an approval record bound to the exact command, cwd, sanitized environment summary, graph revision, and input digest. A changed command or environment invalidates prior approval.

### Interaction Surface

Register one `/neo` command with subcommand parsing and completion. Keep the surface deterministic and stable-ID based:

```text
/neo
/neo status
/neo profile list|use|show|clear
/neo workflow list|show|run|status|pause|resume|stop|history
/neo goal list|create|show|pause|resume|close
/neo todo list|add|show|done|skip
/neo agent list|run|status|steer
```

`/neo` opens the overview UI. Long-running operations are asynchronous. Existing `@agent` and underlying Agent tools remain available as compatibility/direct-specialist entry points.

## Output Structure

```text
src/
  extension.ts
  command.ts
  domain/
    types.ts
    events.ts
    reducer.ts
  state/
    store.ts
    snapshots.ts
    migrations.ts
    task-projection.ts
  runtime/
    native-runtime.ts
    child-session.ts
    model-runtime.ts
    resource-loader.ts
    capability-policy.ts
  profiles/
    profile-loader.ts
    context-resolver.ts
  skills/
    skill-registry.ts
    skill-discovery.ts
  workflows/
    workflow-loader.ts
    workflow-validator.ts
    graph.ts
    mutation-service.ts
    engine.ts
  nodes/
    agent-node.ts
    shell-node.ts
    approval-node.ts
    condition-node.ts
    parallel-node.ts
    evidence-node.ts
  ui/
    dashboard.ts
    status.ts
    approval.ts
    render.ts

test/
  unit/
  integration/
  e2e/
package.json
 tsconfig.json
```

The tree is a scope declaration, not an implementation constraint. Existing repository conventions and verified host types may justify renaming or regrouping files.

## Implementation Units

- [x] U1. **Create the Neo Extension Boundary and Native Runtime**
  - **Goal:** Establish the package entry point, `/neo` command registration, Native Runtime, child-session lifecycle, model runtime, and explicit resource/tool isolation.
  - **Requirements:** R1-R3, R7-R10, R21; runtime decision from origin and Deferred Planning questions.
  - **Dependencies:** None.
  - **Files:** `package.json`, `tsconfig.json`, `src/extension.ts`, `src/command.ts`, `src/runtime/native-runtime.ts`, `src/runtime/child-session.ts`, `src/runtime/model-runtime.ts`, `src/runtime/resource-loader.ts`, `src/runtime/capability-policy.ts`, `test/unit/extension.test.ts`, `test/unit/native-runtime.test.ts`, `test/unit/resource-loader.test.ts`, `test/integration/native-child-session.test.ts`.
  - **Approach:** Depend directly on the public Pi SDK. Create one shared `ModelRuntime`; create each child with `createAgentSession()` and a dedicated `SessionManager` target. Build an explicit ResourceLoader per child context so Profile/Workflow Skill filtering and extension/tool allowlists are deterministic. Normalize session events into Neo attempts, maintain a bounded concurrency queue, and hold a session lease for each running attempt. Implement steer/followUp/stop/resume against the native `AgentSession` and persisted `SessionManager`; resubscribe whenever a session is replaced or reopened. Do not load any existing subagent manager into the child runtime and do not silently fall back to another runtime.
  - **Patterns to follow:** Pi SDK `docs/sdk.md`, `examples/sdk/04-skills.ts`, `examples/sdk/05-tools.ts`, `examples/sdk/06-extensions.ts`, `examples/sdk/11-sessions.ts`, `examples/sdk/12-full-control.ts`, and `examples/sdk/13-session-runtime.ts`. Use the two subagent examples only for behavior and failure-mode references.
  - **Test scenarios:**
    - Loading the extension registers one `/neo` command and does not register a duplicate Agent manager.
    - Native child creation uses the selected model, thinking level, cwd, tools, custom tools, and explicit ResourceLoader.
    - A child ResourceLoader excludes ambient Neo/subagent/task extensions and exposes only the selected Skills/context files.
    - Child events map text, thinking, tool activity, usage, agent end, error, abort, and compaction into one Neo attempt without duplicate terminal events.
    - Steer, followUp, stop, resume, and dispose work across an in-memory session and a reopened persistent SessionManager.
    - Concurrency limits queue extra child sessions without losing stable run/node/attempt identity.
  - **Verification:** A Pi SDK harness can create, drive, persist, reopen, steer, and dispose a native child session without loading either existing subagent plugin.

- [x] U2. **Implement Durable Neo Domain State and Event Reduction**
  - **Goal:** Persist Profiles, Goals, Todos, Workflow definitions, Run records, node attempts, graph revisions, approvals, artifacts, receipts, and audit events.
  - **Requirements:** R2, R16-R20; AE6.
  - **Dependencies:** U1.
  - **Files:** `src/domain/types.ts`, `src/domain/events.ts`, `src/domain/reducer.ts`, `src/state/store.ts`, `src/state/snapshots.ts`, `src/state/migrations.ts`, `src/state/task-projection.ts`, `test/unit/domain-reducer.test.ts`, `test/unit/state-store.test.ts`, `test/unit/task-projection.test.ts`, `test/integration/recovery-state.test.ts`.
  - **Approach:** Use append-only JSONL events with periodic atomic snapshots. Scope project Run state to the active project and keep global Profile/Workflow discovery separate from project execution state. Use stable IDs and monotonic revisions. Preserve attempts rather than overwriting them; a retry creates a new attempt. Define terminal Run states and an explicit `unknown_effect`/blocked state for ambiguous external side effects. Model Todo as a projection over Workflow events and keep manual tasks distinct. Borrow file-locking, stale-lock recovery, and widget-state lessons from `example/pi-tasks`, without importing its internal store or duplicating its task tools.
  - **Patterns to follow:** `example/pi-subagents/src/missions/types.ts`, `example/pi-subagents/src/missions/store.ts`, and its atomic lifecycle artifacts, but do not reuse Mission as Neo's domain model.
  - **Test scenarios:**
    - Replaying events reconstructs the same snapshot as the live reducer.
    - Concurrent graph mutation with a stale revision is rejected without losing the winning mutation.
    - A failed node retry creates a new attempt while preserving the original output and error.
    - A crash after an external action but before a terminal event yields `unknown_effect`, not an automatic rerun.
    - Reloading or restarting Neo restores active Runs, Goals, Todo projections, and pending approvals.
    - A Todo projection reflects Workflow node additions, skips, attempts, dependency blockers, and evidence without becoming a second independent task list.
    - Generic `/tasks` and Neo `/neo todo` can coexist without duplicate tool registration or cross-store corruption.
  - **Verification:** State can be rebuilt from events, snapshots can be replaced atomically, and recovery is deterministic and idempotent.

- [x] U3. **Add Global Profile and Dynamic Skill Context Resolution**
  - **Goal:** Load soft Profile guidance, create temporary Workflow contexts, search/load optional Skills, and fall back to Agent knowledge when discovery fails.
  - **Requirements:** R4-R10; AE2-AE3.
  - **Dependencies:** U1, U2.
  - **Files:** `src/profiles/profile-loader.ts`, `src/profiles/context-resolver.ts`, `src/skills/skill-registry.ts`, `src/skills/skill-discovery.ts`, `test/unit/profile-loader.test.ts`, `test/unit/context-resolver.test.ts`, `test/unit/skill-discovery.test.ts`, `test/integration/skill-fallback.test.ts`.
  - **Approach:** Treat Profile fields as recommendations and context metadata, not hard Workflow dependencies. Resolve normal conversation context from the active Profile. Resolve a direct Workflow context from Workflow/project needs without mutating the active Profile or its memory namespace. Expose a bounded discovery/load interface to Agent nodes; classify results as loaded, missing, unreadable, or invalid, and continue on optional discovery misses. Keep tool capabilities outside Skill content and record selected Skill names plus source digests when available.
  - **Patterns to follow:** Pi Skills discovery rules in `docs/skills.md`, Pi SDK `docs/sdk.md` and `examples/sdk/04-skills.ts`/`13-session-runtime.ts`, plus the two subagent examples' agent isolation behavior. ResourceLoader construction must remain Neo-owned so missing optional Skill discovery can fall back to Agent knowledge.
  - **Test scenarios:**
    - `profile use` changes the default context for ordinary messages without launching a Workflow.
    - A Workflow launched from an incompatible active Profile receives a temporary context and leaves the active Profile unchanged.
    - Skill search returns bounded candidates within the configured scope.
    - A missing or unreadable optional Skill is recorded and the Agent task continues with a fallback provenance marker.
    - Loading a Skill does not add tools or extensions to the Agent capability set.
  - **Verification:** Profile switching, temporary context creation, dynamic Skill fallback, and provenance reporting work independently of the chosen runtime.

- [x] U4. **Define and Validate the Declarative Workflow Graph**
  - **Goal:** Load global YAML Workflow definitions, validate inputs and node contracts, and create a mutable per-run graph.
  - **Requirements:** R3, R11-R13; AE1, AE4.
  - **Dependencies:** U2, U3.
  - **Files:** `src/workflows/workflow-loader.ts`, `src/workflows/workflow-validator.ts`, `src/workflows/graph.ts`, `src/workflows/mutation-service.ts`, `test/unit/workflow-loader.test.ts`, `test/unit/workflow-validator.test.ts`, `test/unit/workflow-graph.test.ts`, `test/integration/workflow-mutation.test.ts`.
  - **Approach:** Use YAML as the primary declarative format. Validate Workflow identity/version, required inputs, node IDs, dependency references, node kinds, risk metadata, approval declarations, and success criteria before creating a Run. Copy the initial graph into the Run and pin the source version. Expose mutation operations for add, skip, split, merge, reorder, and branch; validate dependencies and risk on every mutation, commit atomically, increment graph revision, update Todo projection, and schedule newly-ready nodes.
  - **Patterns to follow:** `example/pi-subagents/test/unit/workflow-graph.test.ts`, `example/pi-subagents/test/unit/scripted-workflow.test.ts`, and the documented distinction between public APIs and internal workflow graph modules.
  - **Test scenarios:**
    - A valid Workflow loads with a pinned version and initial graph snapshot.
    - Missing inputs, duplicate IDs, invalid dependencies, unknown node kinds, and malformed risk/approval metadata fail before Run creation.
    - Adding, skipping, splitting, merging, reordering, and branching produce the expected new revision and Todo projection.
    - A stale mutation revision is rejected; a mutation cannot remove a required approval or create an invalid dependency cycle.
    - A Workflow run records planned and actual routes separately.
  - **Verification:** A valid global Workflow can be inspected and instantiated, and an Agent can safely evolve its per-run graph without mutating the global definition.

- [x] U5. **Implement Workflow Node Execution and Risk Confirmation**
  - **Goal:** Execute Agent, Shell, approval, condition, parallel, artifact, and receipt nodes with consistent attempts, evidence, and failure handling.
  - **Requirements:** R12-R16, R19; AE5-AE6.
  - **Dependencies:** U1, U2, U4.
  - **Files:** `src/nodes/agent-node.ts`, `src/nodes/shell-node.ts`, `src/nodes/approval-node.ts`, `src/nodes/condition-node.ts`, `src/nodes/parallel-node.ts`, `src/nodes/evidence-node.ts`, `src/workflows/engine.ts`, `test/unit/shell-node.test.ts`, `test/unit/approval-node.test.ts`, `test/unit/engine.test.ts`, `test/integration/workflow-execution.test.ts`, `test/integration/shell-confirmation.test.ts`.
  - **Approach:** Use the Native Runtime for Agent nodes and `pi.exec(command, args, options)` for Shell execution, preserving explicit cwd, environment references, signal, timeout, exit code, stdout/stderr capture and bounded output. Allow shell command strings or project commands according to the validated Workflow format, but keep the exact resolved invocation in the approval digest. Risk is the maximum of Workflow declaration, project/action metadata, and runtime classification; Agent may raise risk but cannot lower it. Bind approvals to Run, node, attempt, command digest, environment summary, and graph revision. Keep execution asynchronous and cancellation-aware.
  - **Patterns to follow:** Pi `pi.exec` documentation, Pi SDK `docs/sdk.md`, `examples/sdk/05-tools.ts`, `examples/sdk/11-sessions.ts`, `examples/sdk/13-session-runtime.ts`, and host signal/timeout conventions.
  - **Test scenarios:**
    - Agent nodes preserve structured output and runtime ownership identity.
    - Shell nodes pass cwd, environment, timeout, signal, exit code, stdout, stderr, and killed state into the attempt record.
    - A low-risk read/test node executes without approval; a production/deletion/database-write node pauses with a complete confirmation summary.
    - Changing a command, environment digest, input, or graph revision invalidates an earlier approval.
    - Parallel branches join correctly, retain partial success, and resume only failed or unknown branches.
    - A node cancellation resolves once and leaves a recoverable or terminal state according to policy.
    - Artifact and Receipt nodes record paths/URLs and cannot report success without their required evidence.
  - **Verification:** A local dry-run Workflow demonstrates agent analysis, arbitrary Shell, adaptive nodes, approval, failure, resume, and evidence recording without requiring real production credentials.

- [x] U6. **Build `/neo` Commands, Dashboard, and Approval UI**
  - **Goal:** Provide deterministic commands and a compact overview for Profile, Workflow, Goal, Todo, Agent, Run, and approval operations.
  - **Requirements:** R1-R3, R17-R22; AE1, AE2, AE7.
  - **Dependencies:** U2, U4, U5.
  - **Files:** `src/command.ts`, `src/ui/dashboard.ts`, `src/ui/status.ts`, `src/ui/approval.ts`, `src/ui/render.ts`, `test/unit/command-parser.test.ts`, `test/unit/dashboard.test.ts`, `test/integration/neo-commands.test.ts`, `test/integration/neo-approval-ui.test.ts`.
  - **Approach:** Keep `/neo` as the only top-level command and use stable IDs as command/UI values; display labels must never be used to locate a Run or node. `/neo` opens a dashboard; long operations return asynchronously and update status through persisted Run state. Render current Profile, Goal, Workflow, progress, blockers, dynamic changes, recent Agents, and approval details. Preserve native `@agent`, the underlying subagent tools, and optional `/tasks`; Neo must not register `TaskCreate`, `TaskList`, or `TaskUpdate` duplicates. Natural-language suggestions may point to a Workflow but cannot invoke a high-risk Workflow or approval silently.
  - **Test scenarios:**
    - Every documented `/neo` subcommand parses valid input and returns actionable errors for unknown commands or IDs.
    - `/neo` with no arguments renders empty, active, blocked, and runtime-unavailable dashboard states.
    - Profile use/clear changes normal context without changing active Workflow Runs.
    - Workflow run displays the pinned version, inputs, initial route, risk, and approval points before execution.
    - Approval UI displays exact command, cwd, environment summary, impact, rollback, and graph revision; approval targets the stable Run/node/attempt identity.
    - Goal and Todo views distinguish projected Workflow items from manual Todo items and from optional `pi-tasks` lists.
    - Direct `@agent` usage remains available and is not intercepted as an implicit Workflow.
  - **Verification:** A user can operate the full local dry-run through `/neo` without reading state files or using the underlying runtime commands directly.

- [x] U7. **Complete Runtime, Recovery, and MVP End-to-End Coverage**
  - **Goal:** Prove the vertical slice across Pi SDK Native Runtime, Neo state, Shell, adaptive graph changes, approval, recovery, and evidence.
  - **Requirements:** R1-R22; AE1-AE7.
  - **Dependencies:** U1-U6.
  - **Files:** `test/e2e/neo-release-workflow.test.ts`, `test/e2e/neo-adaptive-workflow.test.ts`, `test/e2e/neo-profile-context.test.ts`, `test/e2e/neo-direct-agent.test.ts`, `test/support/fake-runtime.ts`, `test/support/fake-project.ts`, `test/fixtures/workflows/release-to-production.yaml`, `test/fixtures/profiles/fullstack.yaml`, `test/fixtures/projects/shop-api.yaml`.
  - **Approach:** Use Pi SDK loader/fake-model/session patterns rather than requiring live provider credentials. Exercise a release-like Workflow with harmless fixture Shell commands, a missing Skill fallback, a dynamically added review node, a high-risk approval, a failed native child attempt, resume from the failed SessionManager state, and final receipt. Verify no ambient `pi-subagents`, `tintinweb-pi-subagents`, or `pi-tasks` manager is loaded into child contexts. Add a live smoke command only as an optional maintainer check, not as the normal test suite.
  - **Test scenarios:**
    - The full release Workflow can be started explicitly through `/neo`, creates/attaches Goal and Todo state, and completes with evidence.
    - Missing Skill and missing specialist Agent fall back to general knowledge/capability without marking the ordinary Run failed.
    - Dynamic graph changes are visible in status and survive restart.
    - Production Shell pauses for approval; changing the command after approval requires a new approval.
    - A failed node creates a new attempt on resume and does not rerun completed nodes.
    - A crash with ambiguous external effect enters blocked/unknown-effect and requires explicit user resolution.
    - The Run history distinguishes initial plan, actual plan, approvals, Agent selections, Shell results, artifacts, and receipts.
  - **Verification:** The normal test suite proves the MVP behavior with deterministic fixtures, and the end-to-end fixture is sufficient for later Native Runtime or UI refactors to preserve behavior.

## System-Wide Impact

- **Native child sessions:** Neo creates and controls child `AgentSession` instances through the Pi SDK. It must correlate every child to a Neo Run/node attempt, resubscribe after session replacement, dispose children at terminal state, and reconcile persisted sessions on reload.
- **Existing subagent extensions:** Neo treats `pi-subagents`, `tintinweb-pi-subagents`, and `pi-tasks` as optional ambient extensions that must be excluded from Native child ResourceLoaders by default; the parent session may still have them loaded independently.
- **Skills:** Neo adds scoped discovery and provenance around Pi's Skill mechanism; it must not mutate global Skill availability for ordinary Profile or Workflow use.
- **Shell and secrets:** Neo owns command execution metadata and confirmation, but it is not a process sandbox. Output must be bounded and sanitized before persistence or UI display.
- **Persistence:** Run state must survive compaction/restart and tolerate partial writes. Event replay and atomic snapshot replacement are required for recovery.
- **UI:** Neo's dashboard should show collaboration-level state and provide a Neo child-session detail view. It may borrow FleetView interaction patterns from the examples, but it must not depend on or duplicate an existing subagent FleetView.

## Risks and Mitigations

- **Native child lifecycle leaks:** Every child must have a terminal event guard, session lease, unsubscribe/dispose path, and shutdown reconciliation; `ModelRuntime` is shared but child sessions are individually disposed.
- **Recursive ambient extension loading:** Build explicit ResourceLoaders and exclude Neo, subagent managers, and task managers from children by default.
- **Duplicate task systems:** Treat `pi-tasks` as an optional coexisting extension/reference; keep Neo's Workflow-bound Todo projection separate until a public bridge exists.
- **Dynamic graph race:** Use stable node IDs, graph revision/CAS, atomic event append, and deterministic conflict errors.
- **Unknown external side effect:** Persist pre-execution intent and post-execution evidence; enter `unknown_effect` instead of blind retry.
- **Shell secret leakage:** Store secret references and sanitized environment summaries; cap stdout/stderr and scrub known secret values before persistence/display.
- **Agent autonomy bypasses approval:** Approval is enforced by the Shell node executor, not by Agent prompt instructions; Agent can propose or add a risky node but cannot execute it without the approval gate.
- **Skill prompt injection or irrelevant guidance:** Skill loading remains scoped to Profile/Workflow discovery ranges; record source and keep actual tool capability independent.
- **UI state drift:** Commands use stable IDs and domain state, not display labels or scraped subagent output.
- **MVP scope expansion:** Defer schedules, multi-runtime orchestration, remote Skill sync, team approvals, and autonomous Workflow selection.

## Open Planning Decisions

These are technical decisions for implementation, not product blockers:

- Whether native child sessions should use in-memory sessions with Neo-owned recovery or persisted `SessionManager` files by default; MVP should prefer persisted sessions for resumable Agent nodes.
- How shared `ModelRuntime` refresh/auth errors are surfaced without taking unrelated child sessions down.
- Exact ResourceLoader construction for Profile/Workflow Skill scopes, including whether to use `skillsOverride` only or a full custom `ResourceLoader` for strict extension exclusion.
- Native runtime concurrency, session lease, child disposal, and crash reconciliation semantics.
- Whether Neo should later expose a documented projection adapter to `pi-tasks`, or keep `/neo todo` and `/tasks` permanently separate.
- Exact YAML schema and expression language for conditions; keep expressions deterministic and avoid arbitrary code in the MVP.
- Event log/snapshot retention, migration versioning, and lock strategy.
- Shell command representation and the point at which command strings are resolved into the `pi.exec(command, args)` invocation.
- Whether the first dashboard uses `ctx.ui` primitives only or adds a custom TUI component after the text command path is stable.

## Sequencing

1. U1 establishes the Native Runtime, explicit child resources, concurrency, and command registration.
2. U2 establishes durable domain state and recovery semantics before execution is added.
3. U3 adds Profile and Skill resolution without coupling product state to Pi's global Skill catalog.
4. U4 validates and mutates the declarative graph.
5. U5 executes graph nodes and enforces Shell approval/evidence.
6. U6 exposes the user-facing `/neo` command and dashboard.
7. U7 proves the vertical slice and prevents runtime, recovery, and safety regressions.

## Next Step

-> `/ce-work` to implement U1 after reviewing this plan, or revise the plan first if the Native Runtime or persistence boundary needs a technical decision.
