import { afterEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ShellExecutor } from "../../src/nodes/shell-node.js";
import { NativeAgentRuntime } from "../../src/runtime/native-runtime.js";
import { NeoStateStore } from "../../src/state/store.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowLoader } from "../../src/workflows/workflow-loader.js";
import { createFakeSessionHarness } from "../support/fake-session.js";
import { createFixtureProject } from "../support/fixture-project.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

describe("bundled default workflow", () => {
  it("runs analyze -> work -> test with scout and worker output handoff", async () => {
    const project = await createFixtureProject();
    cleanups.push(project.cleanup);
    const store = await NeoStateStore.open(project.cwd);
    const harness = createFakeSessionHarness([
      { output: "SCOUT-HANDOFF" },
      { output: "WORK-HANDOFF" },
      { output: "TEST-RESULT" },
    ]);
    const runtime = new NativeAgentRuntime({
      cwd: project.cwd,
      stateDirectory: store.directory,
      modelRuntime: {} as ModelRuntime,
      sessionFactory: harness.factory,
    });
    cleanups.push(() => runtime.dispose());
    const loader = new WorkflowLoader(project.cwd);
    const engine = new WorkflowEngine({
      cwd: project.cwd,
      store,
      loader,
      runtime,
      shell: new ShellExecutor(async () => ({ code: 0, stdout: "", stderr: "", killed: false })),
      context: async (workflow) => ({ cwd: project.cwd, workflowName: workflow.name, skills: [], temporary: true }),
    });

    const definition = await loader.get("default");
    expect(definition?.nodes.map((node) => [node.id, node.agent])).toEqual([
      ["analyze", "scout"],
      ["work", "worker"],
      ["test", "worker"],
    ]);

    const completed = await engine.run((await engine.createRun("default", { inputs: { task: "Implement auth checks" } })).id);

    expect(completed.status).toBe("succeeded");
    expect(runtime.status().map((child) => child.agentType)).toEqual(["scout", "worker", "worker"]);
    expect(harness.prompts[1]).toContain("SCOUT-HANDOFF");
    expect(harness.prompts[2]).toContain("SCOUT-HANDOFF");
    expect(harness.prompts[2]).toContain("WORK-HANDOFF");
    expect(harness.options[0]?.tools).not.toContain("edit");
    expect(harness.options[1]?.tools).toContain("edit");
    expect(harness.options[2]?.thinkingLevel).toBe("high");
  });
});
