import { describe, expect, it } from "vitest";
import { createNeoTool, type NeoServices } from "../../src/command.js";
import { NeoStateStore } from "../../src/state/store.js";
import { ProfileLoader } from "../../src/profiles/profile-loader.js";
import { WorkflowLoader } from "../../src/workflows/workflow-loader.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { NativeAgentRuntime } from "../../src/runtime/native-runtime.js";
import { ShellExecutor } from "../../src/nodes/shell-node.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

describe("Neo control tool", () => {
  it("executes a structured status action through the shared services", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "neo-control-tool-"));
    try {
      const store = await NeoStateStore.open(cwd);
      const runtime = new NativeAgentRuntime({ cwd, stateDirectory: store.directory, modelRuntime: {} as never });
      const services: NeoServices = {
        store,
        profiles: new ProfileLoader(cwd),
        workflows: new WorkflowLoader(cwd),
        runtime,
        engine: new WorkflowEngine({
          cwd,
          store,
          loader: new WorkflowLoader(cwd),
          runtime,
          shell: new ShellExecutor(async () => ({ code: 0, stdout: "", stderr: "", killed: false })),
          context: async (workflow) => ({ cwd, workflowName: workflow.name, skills: [], temporary: true }),
        }),
      };
      const tool = createNeoTool(async () => services);
      const result = await (tool as unknown as {
        execute: (id: string, params: unknown, signal: AbortSignal | undefined, update: unknown, ctx: ExtensionContext) => Promise<{ content: Array<{ text: string }> }>;
      }).execute("control", { action: { area: "status" } }, undefined, undefined, { cwd, ui: { notify() {}, setWidget() {} } } as unknown as ExtensionContext);
      expect(result.content[0]?.text).toContain('"status":"ok"');
      expect(result.content[0]?.text).toContain("Profile:");
      await runtime.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
