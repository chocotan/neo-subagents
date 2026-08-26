import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionCommandContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { handleNeoCommand, type NeoServices } from "../../src/command.js";
import { ShellExecutor } from "../../src/nodes/shell-node.js";
import { ProfileLoader } from "../../src/profiles/profile-loader.js";
import { NativeAgentRuntime } from "../../src/runtime/native-runtime.js";
import { NeoStateStore } from "../../src/state/store.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowLoader } from "../../src/workflows/workflow-loader.js";
import { createFakeSessionHarness } from "../support/fake-session.js";
import { createFixtureProject } from "../support/fixture-project.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

function context(cwd: string, notifications: string[]): ExtensionCommandContext {
  return { cwd, ui: { notify: (message: string) => notifications.push(message), setWidget: () => undefined } } as unknown as ExtensionCommandContext;
}

describe("/neo agent run", () => {
  it("creates an anonymous Native child without an agent type", async () => {
    const project = await createFixtureProject();
    cleanups.push(project.cleanup);
    const store = await NeoStateStore.open(project.cwd);
    const harness = createFakeSessionHarness([{ output: "anonymous child result" }]);
    const runtime = new NativeAgentRuntime({ cwd: project.cwd, stateDirectory: store.directory, modelRuntime: {} as ModelRuntime, sessionFactory: harness.factory });
    cleanups.push(() => runtime.dispose());
    const loader = new WorkflowLoader(project.cwd);
    const services: NeoServices = {
      store,
      profiles: new ProfileLoader(project.cwd),
      workflows: loader,
      runtime,
      engine: new WorkflowEngine({
        cwd: project.cwd,
        store,
        loader,
        runtime,
        shell: new ShellExecutor(async () => ({ code: 0, stdout: "", stderr: "", killed: false })),
        context: async (workflow) => ({ cwd: project.cwd, workflowName: workflow.name, skills: [], temporary: true }),
      }),
    };
    const notifications: string[] = [];

    await handleNeoCommand('agent run "检查当前项目的认证流程"', services, context(project.cwd, notifications));

    expect(notifications.at(-1)).toContain("anonymous child result");
    expect(runtime.status()).toHaveLength(1);
    expect(runtime.status()[0]).toMatchObject({ nodeId: "direct", status: "succeeded" });
    expect(harness.options[0]?.tools).toEqual(["neo_context", "neo_skill_search", "neo_skill_load", "neo_workflow_mutate"]);

    await handleNeoCommand('agent run --type scout "只读搜索"', services, context(project.cwd, notifications));
    expect(harness.options[1]?.tools).toContain("read");
    expect(harness.options[1]?.tools).not.toContain("edit");
    expect(harness.options[1]?.thinkingLevel).toBe("low");
    expect(runtime.status()[1]).toMatchObject({ agentType: "scout", maxTurns: 20 });
    expect(notifications.at(-1)).toContain("Agent type: scout");

    await handleNeoCommand("agent list", services, context(project.cwd, notifications));
    expect(notifications.at(-1)).toContain("worker");
    expect(notifications.at(-1)).toContain("scout");
    expect(notifications.at(-1)).not.toContain("general-purpose");
    expect(notifications.at(-1)).not.toContain("Explore");
    expect(notifications.at(-1)).not.toContain("Plan");

    await handleNeoCommand('agent run --type Unknown "失败"', services, context(project.cwd, notifications));
    expect(notifications.at(-1)).toContain('Unknown agent type: "Unknown"');
  });
});
