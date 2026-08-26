import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionCommandContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { handleNeoCommand, type NeoServices } from "../../src/command.js";
import { ShellExecutor } from "../../src/nodes/shell-node.js";
import { ProfileLoader } from "../../src/profiles/profile-loader.js";
import { NativeAgentRuntime } from "../../src/runtime/native-runtime.js";
import { resolveSkills } from "../../src/skills/skill-discovery.js";
import { NeoStateStore } from "../../src/state/store.js";
import { projectedTodoId } from "../../src/state/task-projection.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowLoader } from "../../src/workflows/workflow-loader.js";
import { createFakeSessionHarness } from "../support/fake-session.js";
import { createFixtureProject } from "../support/fixture-project.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

function commandContext(cwd: string, notifications: string[]): ExtensionCommandContext {
  return {
    cwd,
    ui: {
      notify: (message: string) => { notifications.push(message); },
      setWidget: () => undefined,
    },
  } as unknown as ExtensionCommandContext;
}

function resultText(result: unknown): string {
  const value = result as { content?: Array<{ type?: string; text?: string }> };
  return value.content?.find((item) => item.type === "text")?.text ?? "";
}

describe("Neo release workflow e2e", () => {
  it("binds a goal, preserves agent graph mutation, approves a fresh attempt, and projects receipts/todos", async () => {
    const project = await createFixtureProject();
    cleanups.push(project.cleanup);
    const store = await NeoStateStore.open(project.cwd);
    const sessions = createFakeSessionHarness([
      {
        output: "reviewed with missing-skill fallback",
        toolCalls: [
          { name: "neo_skill_search", arguments: { query: "optional-missing-skill" } },
          { name: "neo_skill_load", arguments: { name: "optional-missing-skill" } },
          {
            name: "neo_workflow_mutate",
            arguments: {
              operation: "add",
              reason: "Agent discovered a second release receipt is required",
              node: {
                id: "dynamic-receipt",
                kind: "receipt",
                title: "Dynamic release receipt",
                dependsOn: ["receipt"],
                content: "agent-added release receipt",
              },
            },
          },
        ],
      },
      { output: "tested" },
    ]);
    const runtime = new NativeAgentRuntime({
      cwd: project.cwd,
      stateDirectory: store.directory,
      concurrency: 2,
      modelRuntime: {} as ModelRuntime,
      sessionFactory: sessions.factory,
    });
    cleanups.push(() => runtime.dispose());

    let shellCalls = 0;
    const shell = new ShellExecutor(async () => {
      shellCalls += 1;
      return { code: 0, stdout: "fixture release\n", stderr: "", killed: false };
    });
    const profiles = new ProfileLoader(project.cwd);
    const workflows = new WorkflowLoader(project.cwd);
    const engine = new WorkflowEngine({
      cwd: project.cwd,
      store,
      loader: workflows,
      runtime,
      shell,
      context: async (workflow) => resolveSkills(
        { cwd: project.cwd, workflowName: workflow.name, skills: [], temporary: true },
        workflow.recommendedSkills,
        workflow.discoverScopes,
      ),
    });
    const services: NeoServices = { store, profiles, workflows, engine, runtime };
    const notifications: string[] = [];
    const ctx = commandContext(project.cwd, notifications);

    await handleNeoCommand("goal create Ship fixture release", services, ctx);
    const goalId = notifications.at(-1)?.match(/Goal created: (neo_goal_.+)$/)?.[1];
    expect(goalId).toBeTruthy();

    await handleNeoCommand(`workflow run harmless-release --goal=${goalId} project=shop-api`, services, ctx);
    let snapshot = store.getSnapshot();
    const blocked = Object.values(snapshot.runs)[0]!;
    expect(blocked).toMatchObject({ workflowName: "harmless-release", goalId, status: "blocked" });
    expect(snapshot.goals[goalId!]?.runIds).toContain(blocked.id);
    expect(blocked.graph.revision).toBe(2);
    expect(blocked.graph.nodes["dynamic-receipt"]).toMatchObject({
      status: "pending",
      metadata: { mutationReason: "Agent discovered a second release receipt is required" },
    });
    expect(snapshot.events.filter((event) => event.type === "graph.mutated")).toHaveLength(1);
    expect(snapshot.todos[projectedTodoId(blocked.id, "dynamic-receipt")]).toMatchObject({
      title: "Dynamic release receipt",
      status: "pending",
      manual: false,
    });
    expect(shellCalls).toBe(0);

    const loadResult = sessions.toolResults.find((entry) => entry.name === "neo_skill_load");
    expect(JSON.parse(resultText(loadResult?.result))).toMatchObject({
      name: "optional-missing-skill",
      status: "missing",
      permissionsChanged: false,
      fallback: "Continue using existing knowledge.",
    });
    const mutationResult = sessions.toolResults.find((entry) => entry.name === "neo_workflow_mutate");
    expect(JSON.parse(resultText(mutationResult?.result))).toMatchObject({ status: "applied", graphRevision: 2 });

    await handleNeoCommand(`workflow status ${blocked.id}`, services, ctx);
    expect(notifications.at(-1)).toContain("dynamic-receipt [pending] Dynamic release receipt");

    await handleNeoCommand(`workflow history ${blocked.id}`, services, ctx);
    expect(notifications.at(-1)).toContain(`Planned route: ${blocked.graph.plannedRoute.join(" -> ")}`);
    expect(notifications.at(-1)).toContain("Actual route:");
    expect(notifications.at(-1)).toContain("graph.mutated");
    expect(notifications.at(-1)).toContain("approval.created");
    expect(notifications.at(-1)).toContain("attempt.started");

    await handleNeoCommand(`todo show ${projectedTodoId(blocked.id, "dynamic-receipt")}`, services, ctx);
    expect(JSON.parse(notifications.at(-1) ?? "{}")).toMatchObject({ id: projectedTodoId(blocked.id, "dynamic-receipt"), manual: false });

    const approvalId = blocked.pendingApprovalIds[0]!;
    const blockedAttemptId = blocked.graph.nodes.release!.attempts[0]!;
    await handleNeoCommand(`goal pause ${goalId}`, services, ctx);
    expect(store.getSnapshot().goals[goalId!]?.status).toBe("paused");
    expect(store.getSnapshot().runs[blocked.id]?.status).toBe("paused");

    await handleNeoCommand(`approval approve ${approvalId}`, services, ctx);
    expect(store.getSnapshot().runs[blocked.id]).toMatchObject({ status: "paused", pendingApprovalIds: [] });
    expect(store.getSnapshot().runs[blocked.id]?.graph.nodes.release?.attempts).toHaveLength(1);
    expect(shellCalls).toBe(0);

    await handleNeoCommand(`goal resume ${goalId}`, services, ctx);
    expect(store.getSnapshot().goals[goalId!]?.status).toBe("open");

    snapshot = store.getSnapshot();
    const completed = snapshot.runs[blocked.id]!;
    expect(completed.status).toBe("succeeded");
    expect(completed.graph.revision).toBe(2);
    expect(completed.graph.nodes.release?.attempts).toHaveLength(2);
    expect(completed.attempts[blockedAttemptId]?.status).toBe("blocked");
    const approvedAttemptId = completed.graph.nodes.release!.attempts[1]!;
    expect(completed.attempts[approvedAttemptId]).toMatchObject({ status: "succeeded", approvedBy: "user" });
    expect(shellCalls).toBe(1);
    expect(completed.receiptIds).toHaveLength(2);
    expect(Object.values(snapshot.evidence).filter((evidence) => evidence.runId === completed.id && evidence.kind === "receipt")).toHaveLength(2);
    expect(snapshot.todos[projectedTodoId(completed.id, "receipt")]?.status).toBe("done");
    expect(snapshot.todos[projectedTodoId(completed.id, "dynamic-receipt")]?.status).toBe("done");
  });
});
