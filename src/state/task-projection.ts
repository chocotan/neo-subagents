import type { NeoSnapshot, NodeStatus, Todo, TodoStatus, WorkflowRun } from "../domain/types.js";

const statusMap: Record<NodeStatus, TodoStatus> = {
  pending: "pending",
  running: "in_progress",
  succeeded: "done",
  failed: "failed",
  blocked: "blocked",
  skipped: "skipped",
  unknown_effect: "blocked",
};

export function projectedTodoId(runId: string, nodeId: string): string {
  return `neo_todo_${runId}_${nodeId}`;
}

export function projectRunTodos(snapshot: NeoSnapshot, run: WorkflowRun, timestamp: string): void {
  const liveIds = new Set<string>();
  for (const node of Object.values(run.graph.nodes)) {
    const id = projectedTodoId(run.id, node.id);
    liveIds.add(id);
    const existing = snapshot.todos[id];
    const evidenceIds = node.attempts.flatMap((attemptId) => run.attempts[attemptId]?.evidenceIds ?? []);
    const todo: Todo = {
      id,
      title: node.title,
      status: statusMap[node.status],
      runId: run.id,
      nodeId: node.id,
      manual: false,
      evidenceIds: [...new Set(evidenceIds)],
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    snapshot.todos[id] = todo;
  }

  for (const [id, todo] of Object.entries(snapshot.todos)) {
    if (!todo.manual && todo.runId === run.id && !liveIds.has(id)) delete snapshot.todos[id];
  }
}
