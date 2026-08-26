import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleNeoCommand, createNeoTool, type NeoServices } from "./command.js";
import { NeoStateStore } from "./state/store.js";
import { ProfileLoader, isCompatibleProfile, loadProfileContext } from "./profiles/profile-loader.js";
import { resolveSkills } from "./skills/skill-discovery.js";
import { WorkflowLoader } from "./workflows/workflow-loader.js";
import { WorkflowEngine } from "./workflows/engine.js";
import { NativeAgentRuntime } from "./runtime/native-runtime.js";
import { ShellExecutor } from "./nodes/shell-node.js";
import { NeoStatusController } from "./ui/neo-status.js";

export default function neoExtension(pi: ExtensionAPI): void {
  let services: NeoServices | undefined;
  const statusController = new NeoStatusController();
  const recordRuntimeEvent = (
    store: NeoStateStore,
    payload: Record<string, unknown>,
  ): void => {
    statusController.refresh();
    void store.append("agent.event", payload).then(() => statusController.refresh());
  };
  const ensure = async (cwd: string): Promise<NeoServices> => {
    if (services) return services;
    const store = await NeoStateStore.open(cwd);
    const profiles = new ProfileLoader(cwd);
    const workflows = new WorkflowLoader(cwd);
    const runtime = new NativeAgentRuntime({
      cwd,
      stateDirectory: store.directory,
      onEvent: (child, event) => recordRuntimeEvent(store, {
        childId: child.id,
        runId: child.runId,
        nodeId: child.nodeId,
        attemptId: child.attemptId,
        event: event.type,
      }),
      onToolCall: (child, provenance) => recordRuntimeEvent(store, {
        childId: child.id,
        runId: child.runId,
        nodeId: child.nodeId,
        attemptId: child.attemptId,
        event: "tool_call",
        tool: provenance,
      }),
    });
    const shell = new ShellExecutor((command, args, options) => pi.exec(command, args, options));
    const engine = new WorkflowEngine({ cwd, store, loader: workflows, runtime, shell, context: async (workflow, run) => { const context = await loadProfileContext(cwd, store.getSnapshot().activeProfile, workflow.name); const profile = isCompatibleProfile(context.profile, workflow.name) && !context.temporary ? context.profile : undefined; return resolveSkills({ ...context, profile }, [...new Set([...workflow.recommendedSkills, ...(profile?.recommendedSkills ?? [])])], workflow.discoverScopes); } });
    services = { store, profiles, workflows, engine, runtime };
    return services;
  };
  pi.registerCommand("neo", {
    description: "Neo collaboration dashboard and workflow control",
    handler: async (args, ctx) => {
      try {
        await handleNeoCommand(args, await ensure(ctx.cwd), ctx);
      } finally {
        statusController.refresh();
      }
    },
    getArgumentCompletions: () => [
      { value: "status", label: "status", description: "Show dashboard" },
      { value: "profile", label: "profile", description: "Manage profiles" },
      { value: "workflow", label: "workflow", description: "Manage workflows" },
      { value: "goal", label: "goal", description: "Manage goals" },
      { value: "todo", label: "todo", description: "Manage todos" },
      { value: "agent", label: "agent", description: "Manage child agents" },
      { value: "approval", label: "approval", description: "Review approvals" },
    ],
  });
  pi.registerTool(createNeoTool(ensure));
  pi.on("tool_execution_end", (event) => {
    if (event.toolName === "neo") statusController.refresh();
  });
  pi.on("session_start", async (_event, ctx) => {
    statusController.start(ctx, await ensure(ctx.cwd));
  });
  pi.on("session_shutdown", async () => {
    statusController.stop();
    if (services) {
      await services.store.flush();
      await services.runtime.dispose();
      services = undefined;
    }
  });
}
