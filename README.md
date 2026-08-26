# Neo Subagents

Neo is a Pi extension for native child agents, adaptive workflows, profiles, goals, todos, approvals, and durable execution history.

Neo creates child `AgentSession` instances directly through the Pi SDK. It does not depend on another subagent extension for execution.

## Features

- Anonymous native child agents
- Named `worker` and `scout` agents
- Bundled `analyze -> work -> test` default workflow
- YAML workflows with agent, shell, approval, condition, parallel, artifact, and receipt nodes
- Runtime workflow mutations: add, skip, reorder, split, and merge
- Dynamic Skill search and loading with non-fatal fallback
- Explicit parent Skill inheritance through `useParentSkills: "*"`
- Profiles, Goals, workflow-projected Todos, evidence, and history
- High-risk Shell approval gates
- Compact Pi footer status and a `belowEditor` activity widget
- Durable event log and snapshots under `.pi/neo/`

## Install

From GitHub:

```bash
pi install git:github.com/chocotan/neo-subagents
```

For local development:

```bash
npm install
pi -e ./src/extension.ts
```

Reload an existing Pi session after updating Neo:

```text
/reload
```

## Quick Start

Show Neo status:

```text
/neo
/neo status
```

Run an anonymous child:

```text
/neo agent run "Inspect the authentication flow"
```

Use a named child:

```text
/neo agent run --type scout "Map the authentication flow"
/neo agent run --type worker "Implement the approved authentication fix"
```

List named agents:

```text
/neo agent list
```

Run the bundled default workflow:

```text
/neo workflow run default task="Implement authentication checks"
```

The default workflow is intentionally small:

```text
analyze (scout) -> work (worker) -> test (worker)
```

The `work` node receives the real `analyze` output. The `test` node receives both the analysis and implementation handoff.

## Named Agents

### `scout`

- Read-only tools: `read`, `grep`, `find`, `ls`, `bash`
- Thinking: `low`
- Maximum turns: `20`
- Produces a compact codebase handoff with exact files, symbols, risks, and open questions

### `worker`

- Tools: `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`
- Thinking: `high`
- Maximum turns: `40`
- Acts as the sole writer for an assigned task and validates the completed change

Both agents use:

```yaml
useParentSkills: "*"
```

## Skill Inheritance

Neo keeps Skill inheritance explicit. The default is isolation: an omitted field does not import every parent Skill.

### Profile inheritance

A Profile can inherit every Skill visible to the parent Pi environment:

```yaml
name: development
description: Development profile
useParentSkills: "*"
recommendedSkills:
  - workers-best-practices
discoverScopes:
  - .pi/skills
recommendedAgents:
  - scout
  - worker
recommendedWorkflows:
  - default
```

For a Profile, `useParentSkills: "*"` discovers and merges Skills from:

- Project `.pi/skills/`
- Project and ancestor `.agents/skills/`
- Global Pi agent Skills
- Global `~/.agents/skills/`
- Explicit `discoverScopes`

Project definitions win name collisions. Invalid, unreadable, or missing Skills do not abort ordinary Agent work.

### Agent inheritance

For a named Agent, `useParentSkills: "*"` means the child inherits every Skill already resolved into its parent execution context.

This does not add tools or permissions. `scout` remains read-only even when an inherited Skill discusses editing or deployment.

Anonymous Agents inherit the current execution context directly.

An incompatible temporary Workflow context does not inherit Skills from the active Profile.

## Profiles

Profiles are discovered from:

```text
.pi/profiles/*.yaml
~/.pi/agent/profiles/*.yaml
```

Commands:

```text
/neo profile list
/neo profile use <name>
/neo profile show [name]
/neo profile clear
```

## Workflows

Workflow discovery priority:

```text
project .pi/workflows
> global ~/.pi/agent/workflows
> bundled Neo workflows
```

Commands:

```text
/neo workflow list
/neo workflow show <name>
/neo workflow run <name> key=value
/neo workflow status <run-id>
/neo workflow history <run-id>
/neo workflow pause <run-id>
/neo workflow resume <run-id>
/neo workflow stop <run-id>
```

High-risk Shell nodes stop for explicit approval:

```text
/neo approval list
/neo approval approve <approval-id>
/neo approval reject <approval-id>
```

## Goals and Todos

```text
/neo goal create "Ship authentication checks"
/neo goal list
/neo goal show <goal-id>
/neo goal pause <goal-id>
/neo goal resume <goal-id>
/neo goal close <goal-id>

/neo todo list
/neo todo add "Notify operations"
/neo todo show <todo-id>
/neo todo done <manual-todo-id>
/neo todo skip <manual-todo-id>
```

Workflow Todos are projections of node state and cannot be manually marked complete without execution evidence.

## Development

```bash
npm install
npm run check
```

The test suite includes Native Runtime, Skill inheritance, workflow mutation, approval/resume, UI lifecycle, and end-to-end workflow coverage.

## Security

Neo runs locally with the current user's permissions. It is not an operating-system sandbox. Only load trusted Profiles, Skills, workflows, extensions, and Agent definitions. High-risk Shell nodes require Neo approval, but users remain responsible for reviewing commands and external effects.

## License

MIT
