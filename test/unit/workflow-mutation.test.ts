import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorkflowDefinition, WorkflowRun } from "../../src/domain/types.js";
import { NeoStateStore } from "../../src/state/store.js";
import { projectedTodoId } from "../../src/state/task-projection.js";
import { createGraph } from "../../src/workflows/graph.js";
import { WorkflowMutationService } from "../../src/workflows/mutation-service.js";
import { validateWorkflow, WorkflowValidationError } from "../../src/workflows/workflow-loader.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

function workflow(): WorkflowDefinition {
  return { name: "mutation", version: 1, description: "", risk: "low", inputs: [], recommendedSkills: [], discoverScopes: [], nodes: [{ id: "base", kind: "shell", title: "Base", command: "true" }], successCriteria: [], sourcePath: "fixture", sourceDigest: "digest" };
}

function graphWorkflow(): WorkflowDefinition {
  return { name: "graph-mutation", version: 1, description: "", risk: "low", inputs: [], recommendedSkills: [], discoverScopes: [], nodes: [
    { id: "base", kind: "shell", title: "Base", command: "true" },
    { id: "target", kind: "agent", title: "Target", prompt: "target", dependsOn: ["base"] },
    { id: "parallel", kind: "shell", title: "Parallel", command: "true", dependsOn: ["base"] },
    { id: "after", kind: "receipt", title: "After", content: "done", dependsOn: ["target", "parallel"] },
  ], successCriteria: [], sourcePath: "fixture", sourceDigest: "digest" };
}

function makeRun(): WorkflowRun {
  const now = new Date().toISOString();
  return { id: "run-mutation", workflowName: "mutation", workflowVersion: 1, status: "pending", inputs: {}, graph: createGraph(workflow()), attempts: {}, pendingApprovalIds: [], artifactIds: [], receiptIds: [], createdAt: now, updatedAt: now };
}

describe("workflow validation and durable mutation", () => {
  it("rejects invalid parallel branch references", () => {
    const invalid = workflow();
    invalid.nodes.unshift({ id: "fanout", kind: "parallel", title: "Fanout", branches: ["missing"], join: "all" });
    expect(() => validateWorkflow(invalid)).toThrow(/missing parallel branch/);
  });

  it("records add, skip and reorder events with revision checks", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "neo-mutation-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const store = await NeoStateStore.open(cwd);
    const initial = makeRun();
    await store.append("run.created", { run: initial });
    const service = new WorkflowMutationService(store);

    const added = await service.apply(initial.id, 1, { type: "add", node: { id: "extra", kind: "agent", title: "Extra", prompt: "Review", dependsOn: ["base"] }, reason: "discovered review" });
    expect(added.graph.revision).toBe(2);
    expect(store.getSnapshot().todos[projectedTodoId(initial.id, "extra")]?.manual).toBe(false);
    await expect(service.apply(initial.id, 1, { type: "skip", nodeId: "extra", reason: "stale" })).rejects.toBeInstanceOf(WorkflowValidationError);

    const skipped = await service.apply(initial.id, 2, { type: "skip", nodeId: "extra", reason: "not needed" });
    expect(skipped.graph.nodes.extra?.status).toBe("skipped");
    const reordered = await service.apply(initial.id, 3, { type: "reorder", order: ["base", "extra"], reason: "dependency order" });
    expect(reordered.graph.revision).toBe(4);
    expect(store.getSnapshot().events.filter((event) => event.type === "graph.mutated")).toHaveLength(3);
  });

  it("splits and merges pending nodes while preserving dependencies, routes, revisions, and todos", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "neo-split-merge-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const store = await NeoStateStore.open(cwd);
    const initial: WorkflowRun = { ...makeRun(), workflowName: "graph-mutation", graph: createGraph(graphWorkflow()) };
    await store.append("run.created", { run: initial });
    const service = new WorkflowMutationService(store);

    const split = await service.apply(initial.id, 1, {
      type: "split",
      nodeId: "target",
      nodes: [
        { id: "part-one", kind: "agent", title: "Part one", prompt: "one" },
        { id: "part-two", kind: "agent", title: "Part two", prompt: "two" },
      ],
      reason: "Decompose target",
    });
    expect(split.graph.revision).toBe(2);
    expect(split.graph.plannedRoute).toEqual(["base", "part-one", "part-two", "parallel", "after"]);
    expect(split.graph.nodes["part-one"]?.dependsOn).toEqual(["base"]);
    expect(split.graph.nodes["part-two"]?.dependsOn).toEqual(["part-one"]);
    expect(split.graph.nodes.after?.dependsOn).toEqual(["part-two", "parallel"]);
    expect(split.graph.nodes.target).toBeUndefined();
    expect(store.getSnapshot().todos[projectedTodoId(initial.id, "target")]).toBeUndefined();
    expect(store.getSnapshot().todos[projectedTodoId(initial.id, "part-two")]).toMatchObject({ manual: false, status: "pending" });

    const merged = await service.apply(initial.id, 2, {
      type: "merge",
      nodeIds: ["part-two", "parallel"],
      node: { id: "combined", kind: "agent", title: "Combined", prompt: "combine" },
      reason: "Combine remaining work",
    });
    expect(merged.graph.revision).toBe(3);
    expect(merged.graph.plannedRoute).toEqual(["base", "part-one", "combined", "after"]);
    expect(merged.graph.nodes.combined?.dependsOn).toEqual(["part-one", "base"]);
    expect(merged.graph.nodes.after?.dependsOn).toEqual(["combined"]);
    expect(store.getSnapshot().todos[projectedTodoId(initial.id, "combined")]).toMatchObject({ manual: false, title: "Combined" });
    expect(store.getSnapshot().events.filter((event) => event.type === "graph.mutated")).toHaveLength(2);
  });

  it("rejects non-pending sources, duplicate ids, missing dependencies, and cycles", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "neo-split-merge-invalid-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const store = await NeoStateStore.open(cwd);
    const initial = { ...makeRun(), workflowName: "graph-mutation", graph: createGraph(graphWorkflow()) };
    await store.append("run.created", { run: initial });
    const service = new WorkflowMutationService(store);

    await expect(service.apply(initial.id, 1, { type: "split", nodeId: "target", nodes: [
      { id: "duplicate", kind: "agent", title: "One", prompt: "one" },
      { id: "duplicate", kind: "agent", title: "Two", prompt: "two" },
    ], reason: "invalid" })).rejects.toThrow(/Duplicate/);
    await expect(service.apply(initial.id, 1, { type: "split", nodeId: "target", nodes: [
      { id: "one", kind: "agent", title: "One", prompt: "one", dependsOn: ["missing"] },
      { id: "two", kind: "agent", title: "Two", prompt: "two" },
    ], reason: "invalid" })).rejects.toThrow(/missing node/);
    await expect(service.apply(initial.id, 1, { type: "split", nodeId: "target", nodes: [
      { id: "one", kind: "agent", title: "One", prompt: "one", dependsOn: ["after"] },
      { id: "two", kind: "agent", title: "Two", prompt: "two" },
    ], reason: "cycle" })).rejects.toThrow(/cycle/);

    const running = structuredClone(initial);
    running.graph.nodes.target!.status = "running";
    await store.append("run.updated", { run: running });
    await expect(service.apply(initial.id, 1, { type: "merge", nodeIds: ["target", "parallel"], node: { id: "combined", kind: "agent", title: "Combined", prompt: "combine" }, reason: "invalid" })).rejects.toThrow(/Cannot merge running node/);
  });
});
