import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ShellExecutor } from "../../src/nodes/shell-node.js";
import { NativeAgentRuntime } from "../../src/runtime/native-runtime.js";
import { NeoStateStore } from "../../src/state/store.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowLoader } from "../../src/workflows/workflow-loader.js";
import { createFakeSessionHarness, deferred } from "../support/fake-session.js";
import { createFixtureProject } from "../support/fixture-project.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for workflow state");
}

describe("workflow execution", () => {
  it("executes parallel branches concurrently and approval creates a fresh attempt", async () => {
    const project = await createFixtureProject();
    cleanups.push(project.cleanup);
    const store = await NeoStateStore.open(project.cwd);
    const gate = deferred();
    const sessions = createFakeSessionHarness([{ output: "reviewed", waitFor: gate.promise }, { output: "tested", waitFor: gate.promise }]);
    const runtime = new NativeAgentRuntime({ cwd: project.cwd, stateDirectory: store.directory, concurrency: 2, modelRuntime: {} as ModelRuntime, sessionFactory: sessions.factory });
    cleanups.push(() => runtime.dispose());
    let shellCalls = 0;
    const shell = new ShellExecutor(async () => { shellCalls += 1; return { code: 0, stdout: "fixture release\n", stderr: "", killed: false }; });
    const loader = new WorkflowLoader(project.cwd);
    const engine = new WorkflowEngine({ cwd: project.cwd, store, loader, runtime, shell, context: async (workflow) => ({ cwd: project.cwd, workflowName: workflow.name, skills: [], temporary: true }) });
    const created = await engine.createRun("harmless-release", { inputs: { project: "shop-api" } });
    const running = engine.run(created.id);
    await waitUntil(() => runtime.status().filter((child) => child.status === "running").length === 2);
    gate.resolve();
    const blocked = await running;
    expect(blocked.status).toBe("blocked");
    expect(blocked.graph.nodes.fanout?.status).toBe("succeeded");
    expect(blocked.graph.nodes.review?.status).toBe("succeeded");
    expect(blocked.graph.nodes.test?.status).toBe("succeeded");
    expect(shellCalls).toBe(0);
    const approvalId = blocked.pendingApprovalIds[0]!;
    const firstAttemptId = blocked.graph.nodes.release!.attempts[0]!;
    expect(blocked.attempts[firstAttemptId]?.status).toBe("blocked");

    const completed = await engine.approve(approvalId, true);
    expect(completed.status).toBe("succeeded");
    expect(shellCalls).toBe(1);
    expect(completed.graph.nodes.release?.attempts).toHaveLength(2);
    expect(completed.graph.nodes.release?.attempts[0]).toBe(firstAttemptId);
    const retryId = completed.graph.nodes.release!.attempts[1]!;
    expect(completed.attempts[retryId]).toMatchObject({ status: "succeeded", approvedBy: "user" });
    expect(store.getSnapshot().todos).toEqual(expect.objectContaining({
      [`neo_todo_${created.id}_release`]: expect.objectContaining({ manual: false, status: "done" }),
    }));
  });

  it("reject marks the blocked attempt failed and resume retries only failed nodes", async () => {
    const project = await createFixtureProject();
    cleanups.push(project.cleanup);
    await writeFile(join(project.cwd, ".pi", "workflows", "retry.yaml"), `name: retry\nversion: 1\ndescription: retry fixture\nrisk: low\ninputs: []\nrecommendedSkills: []\ndiscoverScopes: []\nnodes:\n  - id: flaky\n    kind: shell\n    title: Flaky\n    command: fixture\nsuccessCriteria: []\n`);
    const store = await NeoStateStore.open(project.cwd);
    const runtime = new NativeAgentRuntime({ cwd: project.cwd, stateDirectory: store.directory, modelRuntime: {} as ModelRuntime, sessionFactory: createFakeSessionHarness().factory });
    cleanups.push(() => runtime.dispose());
    let calls = 0;
    const shell = new ShellExecutor(async () => ({ code: ++calls === 1 ? 1 : 0, stdout: "", stderr: calls === 1 ? "failed" : "", killed: false }));
    const loader = new WorkflowLoader(project.cwd);
    const engine = new WorkflowEngine({ cwd: project.cwd, store, loader, runtime, shell, context: async (workflow) => ({ cwd: project.cwd, workflowName: workflow.name, skills: [], temporary: true }) });
    const failed = await engine.run((await engine.createRun("retry")).id);
    expect(failed.status).toBe("failed");
    const resumed = await engine.resume(failed.id);
    expect(resumed.status).toBe("succeeded");
    expect(resumed.graph.nodes.flaky?.attempts).toHaveLength(2);
    expect(calls).toBe(2);

    const approvalRun = await engine.run((await engine.createRun("harmless-release", { inputs: { project: "reject" } })).id);
    const rejected = await engine.approve(approvalRun.pendingApprovalIds[0]!, false);
    expect(rejected.status).toBe("failed");
    const blockedAttempt = rejected.graph.nodes.release!.attempts[0]!;
    expect(rejected.attempts[blockedAttempt]).toMatchObject({ status: "failed", error: "Approval rejected" });
  });
});
