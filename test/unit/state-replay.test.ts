import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptySnapshot, replay } from "../../src/domain/reducer.js";
import type { Todo, WorkflowDefinition, WorkflowRun } from "../../src/domain/types.js";
import { NeoStateStore } from "../../src/state/store.js";
import { projectedTodoId } from "../../src/state/task-projection.js";
import { createGraph } from "../../src/workflows/graph.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

function definition(): WorkflowDefinition {
  return {
    name: "projection", version: 1, description: "", risk: "low", inputs: [], recommendedSkills: [], discoverScopes: [],
    nodes: [{ id: "check", kind: "shell", title: "Check", command: "true" }], successCriteria: [], sourcePath: "fixture", sourceDigest: "digest",
  };
}

function run(): WorkflowRun {
  const now = new Date().toISOString();
  return { id: "run-1", workflowName: "projection", workflowVersion: 1, status: "pending", inputs: {}, graph: createGraph(definition()), attempts: {}, pendingApprovalIds: [], artifactIds: [], receiptIds: [], createdAt: now, updatedAt: now };
}

describe("Neo state replay and todo projection", () => {
  it("projects workflow nodes while preserving manual todos", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "neo-store-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const store = await NeoStateStore.open(cwd);
    const now = new Date().toISOString();
    const manual: Todo = { id: "manual-1", title: "Manual", status: "pending", manual: true, evidenceIds: [], createdAt: now, updatedAt: now };
    await store.append("todo.created", { todo: manual });
    const created = run();
    await store.append("run.created", { run: created });
    expect(store.getSnapshot().todos[projectedTodoId(created.id, "check")]).toMatchObject({ manual: false, status: "pending", runId: created.id, nodeId: "check" });

    created.graph.nodes.check!.status = "succeeded";
    await store.append("run.updated", { run: created });
    const live = store.getSnapshot();
    expect(live.todos[projectedTodoId(created.id, "check")]?.status).toBe("done");
    expect(live.todos[manual.id]).toEqual(manual);
    expect(replay(live.events, emptySnapshot())).toEqual(live);

    const reopened = await NeoStateStore.open(cwd);
    expect(reopened.getSnapshot()).toEqual(live);
  });
});
