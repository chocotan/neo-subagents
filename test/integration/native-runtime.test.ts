import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { NodeAttempt, WorkflowRun } from "../../src/domain/types.js";
import { NativeAgentRuntime } from "../../src/runtime/native-runtime.js";
import type { NeoAgentConfig } from "../../src/agents/registry.js";
import { createFakeSessionHarness, deferred } from "../support/fake-session.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

function attempt(id: string): NodeAttempt {
  return { id, runId: "run", nodeId: id, status: "running", startedAt: new Date().toISOString(), graphRevision: 1, evidenceIds: [] };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for runtime state");
}

function resultText(result: unknown): string {
  const value = result as { content?: Array<{ type?: string; text?: string }> };
  return value.content?.find((item) => item.type === "text")?.text ?? "";
}

describe("NativeAgentRuntime", () => {
  it("exposes queued/running/terminal states and preserves child cwd isolation", async () => {
    const root = await mkdtemp(join(tmpdir(), "neo-runtime-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const gate = deferred();
    const harness = createFakeSessionHarness([{ output: "one", waitFor: gate.promise }, { output: "two" }]);
    const runtime = new NativeAgentRuntime({ cwd: root, stateDirectory: join(root, "state"), concurrency: 1, modelRuntime: {} as ModelRuntime, sessionFactory: harness.factory });
    cleanups.push(() => runtime.dispose());
    const childCwd = join(root, "project");
    const first = runtime.spawn({ runId: "run", nodeId: "one", attempt: attempt("one"), prompt: "one", context: { cwd: childCwd, skills: [], temporary: true } });
    const second = runtime.spawn({ runId: "run", nodeId: "two", attempt: attempt("two"), prompt: "two", context: { cwd: childCwd, skills: [], temporary: true } });
    await waitUntil(() => runtime.status().length === 2 && runtime.status().some((child) => child.status === "running"));
    expect(runtime.status().map((child) => child.status).sort()).toEqual(["queued", "running"]);
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "succeeded", output: "one", cwd: childCwd }),
      expect.objectContaining({ status: "succeeded", output: "two", cwd: childCwd }),
    ]);
    expect(harness.options.every((option) => option.cwd === childCwd)).toBe(true);
    expect(harness.options[0]?.tools).toEqual(["neo_context", "neo_skill_search", "neo_skill_load", "neo_workflow_mutate"]);
    expect(harness.options[0]?.resourceLoader?.getExtensions().extensions).toHaveLength(0);
  });

  it("registers and dispatches split and merge through the child custom tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "neo-runtime-mutation-tool-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const harness = createFakeSessionHarness([{
      toolCalls: [
        { name: "neo_workflow_mutate", arguments: { operation: "split", nodeId: "target", reason: "decompose", nodes: [
          { id: "part-one", kind: "agent", title: "Part one", prompt: "one" },
          { id: "part-two", kind: "agent", title: "Part two", prompt: "two" },
        ] } },
        { name: "neo_workflow_mutate", arguments: { operation: "merge", nodeIds: ["part-one", "part-two"], reason: "combine", node: { id: "combined", kind: "agent", title: "Combined", prompt: "combine" } } },
      ],
    }]);
    const mutations: string[] = [];
    let revision = 1;
    const run = { id: "run", graph: { revision, nodes: {}, plannedRoute: [], actualRoute: [] } } as unknown as WorkflowRun;
    const runtime = new NativeAgentRuntime({ cwd: root, stateDirectory: join(root, "state"), modelRuntime: {} as ModelRuntime, sessionFactory: harness.factory });
    cleanups.push(() => runtime.dispose());
    await runtime.spawn({
      runId: "run",
      nodeId: "agent",
      attempt: attempt("tool"),
      prompt: "mutate",
      context: { cwd: root, skills: [], temporary: true },
      mutateWorkflow: async (mutation) => {
        mutations.push(mutation.type);
        revision += 1;
        return { ...run, graph: { ...run.graph, revision } };
      },
    });
    expect(mutations).toEqual(["split", "merge"]);
    expect(harness.toolResults.map((entry) => JSON.parse(resultText(entry.result)).status)).toEqual(["applied", "applied"]);
  });

  it("propagates model errors and resumes the persisted session with original context", async () => {
    const root = await mkdtemp(join(tmpdir(), "neo-resume-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const harness = createFakeSessionHarness([{ error: "provider failed" }, { output: "recovered" }]);
    const runtime = new NativeAgentRuntime({ cwd: root, stateDirectory: join(root, "state"), modelRuntime: {} as ModelRuntime, sessionFactory: harness.factory });
    cleanups.push(() => runtime.dispose());
    const spawned = await runtime.spawn({ runId: "run", nodeId: "agent", attempt: attempt("agent"), prompt: "start", context: { cwd: root, workflowName: "fixture", skills: [], temporary: true } });
    expect(spawned).toMatchObject({ status: "failed", error: "provider failed" });
    const resumed = await runtime.resume(spawned.id, "retry");
    expect(resumed).toMatchObject({ status: "succeeded", output: "recovered", cwd: root });
    expect(harness.options).toHaveLength(2);
    expect(harness.disposeCount).toBeGreaterThanOrEqual(1);
  });

  it("stops a running child once and rejects work after disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "neo-stop-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const gate = deferred();
    const harness = createFakeSessionHarness([{ output: "late", waitFor: gate.promise }]);
    const runtime = new NativeAgentRuntime({ cwd: root, stateDirectory: join(root, "state"), modelRuntime: {} as ModelRuntime, sessionFactory: harness.factory });
    const spawning = runtime.spawn({ runId: "run", nodeId: "stop", attempt: attempt("stop"), prompt: "wait", context: { cwd: root, skills: [], temporary: true } });
    await waitUntil(() => runtime.status("neo_child_stop")[0]?.status === "running");
    await runtime.stop("neo_child_stop");
    gate.resolve();
    await expect(spawning).resolves.toMatchObject({ status: "stopped" });
    expect(harness.abortCount).toBe(1);
    await runtime.dispose();
    await expect(runtime.spawn({ runId: "run", nodeId: "x", attempt: attempt("x"), prompt: "x", context: { cwd: root, skills: [], temporary: true } })).rejects.toThrow(/disposed/);
  });

  it("applies parent skills per named-agent opt-in without changing tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "neo-runtime-skills-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const source = join(root, "parent", "SKILL.md");
    await mkdir(join(root, "parent"), { recursive: true });
    await writeFile(source, "parent guidance");
    const harness = createFakeSessionHarness([{ output: "worker" }, { output: "plain" }]);
    const runtime = new NativeAgentRuntime({ cwd: root, stateDirectory: join(root, "state"), modelRuntime: {} as ModelRuntime, sessionFactory: harness.factory });
    cleanups.push(() => runtime.dispose());
    const context = { cwd: root, skills: [{ name: "parent", status: "loaded" as const, source, content: "parent guidance" }], inheritedSkillCount: 1, useParentSkills: "*" as const, temporary: false };

    await runtime.spawn({ runId: "run", nodeId: "worker", attempt: attempt("worker-skills"), prompt: "work", agentType: "worker", context });
    expect(harness.options[0]?.resourceLoader?.getSkills().skills.map((skill) => skill.name)).toEqual(["parent"]);
    expect(harness.options[0]?.tools).toEqual([
      "read", "grep", "find", "ls", "bash", "edit", "write",
      "neo_context", "neo_skill_search", "neo_skill_load", "neo_workflow_mutate",
    ]);

    await runtime.spawn({ runId: "run", nodeId: "anonymous", attempt: attempt("anonymous-skills"), prompt: "anonymous", context });
    expect(harness.options[1]?.resourceLoader?.getSkills().skills.map((skill) => skill.name)).toEqual(["parent"]);

    const noInheritance = { name: "plain", displayName: "Plain", color: "white", description: "", tools: ["read"], thinking: "low", maxTurns: 1, systemPrompt: "", promptMode: "append" } as NeoAgentConfig;
    await runtime.spawn({ runId: "run", nodeId: "plain", attempt: attempt("plain-skills"), prompt: "plain", context, config: noInheritance });
    expect(harness.options[2]?.resourceLoader?.getSkills().skills).toEqual([]);
    expect(harness.options[2]?.tools).toEqual(["read", "neo_context", "neo_skill_search", "neo_skill_load", "neo_workflow_mutate"]);
  });

  it("applies scout tools, prompt, thinking, and turn budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "neo-agent-config-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const harness = createFakeSessionHarness([{ output: "scouted" }]);
    const runtime = new NativeAgentRuntime({
      cwd: root,
      stateDirectory: join(root, "state"),
      modelRuntime: {} as ModelRuntime,
      sessionFactory: harness.factory,
    });
    cleanups.push(() => runtime.dispose());

    const child = await runtime.spawn({
      runId: "run",
      nodeId: "scout",
      attempt: attempt("scout"),
      prompt: "search",
      agentType: "scout",
      context: { cwd: root, skills: [], temporary: true },
    });

    expect(child).toMatchObject({ agentType: "scout", maxTurns: 20, config: { name: "scout" } });
    expect(harness.options[0]?.thinkingLevel).toBe("low");
    expect(harness.options[0]?.tools).toEqual([
      "read", "grep", "find", "ls", "bash",
      "neo_context", "neo_skill_search", "neo_skill_load", "neo_workflow_mutate",
    ]);
    expect(harness.options[0]?.resourceLoader?.getSystemPrompt()).toContain("scouting subagent");
    expect(harness.options[0]?.tools).not.toContain("edit");
    expect(harness.options[0]?.tools).not.toContain("write");
  });
});
