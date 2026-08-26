import type { Goal, NeoEvent, NeoSnapshot, Todo, WorkflowRun } from "./types.js";
import { projectRunTodos } from "../state/task-projection.js";

export function emptySnapshot(): NeoSnapshot {
  return { schemaVersion: 1, revision: 0, goals: {}, todos: {}, runs: {}, approvals: {}, evidence: {}, events: [] };
}

function asString(value: unknown): string { return typeof value === "string" ? value : ""; }
function asRecord(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }

export function reduceSnapshot(snapshot: NeoSnapshot, event: NeoEvent): NeoSnapshot {
  const next: NeoSnapshot = structuredClone(snapshot);
  next.revision += 1;
  next.events.push(event);
  const p = event.payload;
  switch (event.type) {
    case "profile.set": next.activeProfile = asString(p.name); break;
    case "profile.clear": delete next.activeProfile; break;
    case "goal.created": {
      const goal = p.goal as Goal;
      next.goals[goal.id] = goal;
      break;
    }
    case "goal.updated": {
      const goal = p.goal as Goal;
      next.goals[goal.id] = goal;
      break;
    }
    case "todo.created": {
      const todo = p.todo as Todo;
      next.todos[todo.id] = todo;
      break;
    }
    case "todo.updated": {
      const todo = p.todo as Todo;
      next.todos[todo.id] = todo;
      break;
    }
    case "run.created":
    case "run.updated":
    case "graph.mutated": {
      const run = p.run as WorkflowRun;
      next.runs[run.id] = run;
      projectRunTodos(next, run, event.timestamp);
      break;
    }
    case "approval.created": next.approvals[asString(p.approvalId)] = p.approval as NeoSnapshot["approvals"][string]; break;
    case "approval.updated": next.approvals[asString(p.approvalId)] = p.approval as NeoSnapshot["approvals"][string]; break;
    case "evidence.created": next.evidence[asString(p.evidenceId)] = p.evidence as NeoSnapshot["evidence"][string]; break;
    case "state.replaced": {
      const replacement = asRecord(p.snapshot) as unknown as NeoSnapshot;
      return { ...replacement, events: [...replacement.events, event], revision: replacement.revision + 1 };
    }
  }
  return next;
}

export function replay(events: readonly NeoEvent[], initial: NeoSnapshot = emptySnapshot()): NeoSnapshot {
  return events.reduce(reduceSnapshot, initial);
}
