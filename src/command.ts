import { defineTool, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stableId, NeoStateStore } from "./state/store.js";
import { ProfileLoader } from "./profiles/profile-loader.js";
import { WorkflowLoader } from "./workflows/workflow-loader.js";
import { WorkflowEngine } from "./workflows/engine.js";
import { resolveSkills } from "./skills/skill-discovery.js";
import { formatBuiltinAgents, getBuiltinAgent } from "./agents/registry.js";
import type { Goal, GraphMutation, NodeAttempt, RiskLevel, Todo, WorkflowNode } from "./domain/types.js";
import type { NativeAgentRuntime } from "./runtime/native-runtime.js";

export interface NeoServices { store: NeoStateStore; profiles: ProfileLoader; workflows: WorkflowLoader; engine: WorkflowEngine; runtime: NativeAgentRuntime; }
export function splitArgs(input: string): string[] {
  const result: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = (): void => { if (token) result.push(token); token = ""; };
  for (const character of input.trim()) {
    if (escaped) { token += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = undefined; else token += character; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/.test(character)) { push(); continue; }
    token += character;
  }
  if (escaped) token += "\\";
  if (quote) throw new Error(`Unterminated ${quote} quote`);
  push();
  return result;
}

export async function handleNeoCommand(raw: string, services: NeoServices, ctx: ExtensionCommandContext): Promise<void> {
  const args = splitArgs(raw); const command = args.shift() ?? "status"; const snapshot = services.store.getSnapshot();
  try {
    if (command === "status") return renderDashboard(ctx, services);
    if (command === "profile") return await profileCommand(args, services, ctx);
    if (command === "workflow") return await workflowCommand(args, services, ctx);
    if (command === "goal") return await goalCommand(args, services, ctx);
    if (command === "todo") return await todoCommand(args, services, ctx);
    if (command === "agent") return await agentCommand(args, services, ctx);
    if (command === "approval") return await approvalCommand(args, services, ctx);
    throw new Error(`Unknown /neo command: ${command}`);
  } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
  void snapshot;
}

async function profileCommand(args: string[], services: NeoServices, ctx: ExtensionCommandContext): Promise<void> {
  const action = args.shift() ?? "list";
  if (action === "list") return notify(ctx, (await services.profiles.list()).map((profile) => `${profile.name}: ${profile.description}`).join("\n") || "No profiles found");
  if (action === "use") { const name = args[0]; if (!name || !(await services.profiles.get(name))) throw new Error(`Profile not found: ${name}`); await services.store.append("profile.set", { name }); return notify(ctx, `Profile active: ${name}`); }
  if (action === "clear") { await services.store.append("profile.clear", {}); return notify(ctx, "Profile cleared"); }
  if (action === "show") { const name = args[0] ?? services.store.getSnapshot().activeProfile; if (!name) return notify(ctx, "No active profile"); const profile = await services.profiles.get(name); if (!profile) throw new Error(`Profile not found: ${name}`); return notify(ctx, JSON.stringify(profile, null, 2)); }
  throw new Error("Usage: /neo profile list|use <name>|show [name]|clear");
}
async function workflowCommand(args: string[], services: NeoServices, ctx: ExtensionCommandContext): Promise<void> {
  const action = args.shift() ?? "list";
  const snapshot = services.store.getSnapshot();
  if (action === "list") return notify(ctx, (await services.workflows.list()).map((workflow) => `${workflow.name}@${workflow.version} [${workflow.risk}] ${workflow.description}`).join("\n") || "No workflows found");
  if (action === "show") {
    const workflow = await services.workflows.get(args[0] ?? "");
    if (!workflow) throw new Error("Workflow not found");
    return notify(ctx, JSON.stringify(workflow, null, 2));
  }
  if (action === "run") {
    const name = args.shift();
    if (!name) throw new Error("Usage: /neo workflow run <name> [goal=<goal-id>|--goal=<goal-id>] [key=value ...]");
    const { goalId, inputs } = parseRunOptions(args);
    const run = await services.engine.createRun(name, { inputs, goalId });
    return notify(ctx, renderRun(await services.engine.run(run.id)));
  }
  if (action === "history") {
    const runId = args[0];
    if (!runId) throw new Error("Usage: /neo workflow history <run-id>");
    const run = snapshot.runs[runId];
    if (!run) throw new Error(`Run not found: ${runId}`);
    return notify(ctx, renderHistory(run, snapshot.events));
  }
  if (["add", "skip", "reorder"].includes(action)) {
    const runId = args.shift();
    if (!runId) throw new Error(`Usage: /neo workflow ${action} <run-id> ...`);
    const current = services.store.getSnapshot().runs[runId];
    if (!current) throw new Error(`Run not found: ${runId}`);
    if (action === "add") {
      const nodeId = args.shift();
      const kind = args.shift() as WorkflowNode["kind"] | undefined;
      if (!nodeId || !kind) throw new Error("Usage: /neo workflow add <run-id> <node-id> <kind> [title=...] [reason=...]");
      const options = parseAssignments(args);
      const node: WorkflowNode = {
        id: nodeId,
        kind,
        title: options.title ?? nodeId,
        dependsOn: commaList(options.depends ?? options.dependsOn),
        command: options.command,
        args: commaList(options.args),
        prompt: options.prompt,
        risk: options.risk as RiskLevel | undefined,
        approval: options.approval === undefined ? undefined : options.approval === "true",
        branches: commaList(options.branches),
        join: options.join as "all" | "any" | undefined,
      };
      const changed = await services.engine.mutateGraph(runId, { type: "add", node, reason: options.reason ?? "Added through /neo" }, numericRevision(options.revision, current.graph.revision));
      return notify(ctx, renderRun(changed));
    }
    if (action === "skip") {
      const nodeId = args.shift();
      if (!nodeId) throw new Error("Usage: /neo workflow skip <run-id> <node-id> [reason]");
      const options = parseAssignments(args);
      const reason = options.reason ?? (args.filter((arg) => !arg.includes("=")).join(" ") || "Skipped through /neo");
      const changed = await services.engine.mutateGraph(runId, { type: "skip", nodeId, reason }, numericRevision(options.revision, current.graph.revision));
      return notify(ctx, renderRun(changed));
    }
    const order = commaList(args.shift());
    if (!order?.length) throw new Error("Usage: /neo workflow reorder <run-id> <node-id,...> [reason=...]");
    const options = parseAssignments(args);
    const changed = await services.engine.mutateGraph(runId, { type: "reorder", order, reason: options.reason ?? "Reordered through /neo" }, numericRevision(options.revision, current.graph.revision));
    return notify(ctx, renderRun(changed));
  }
  const runId = args[0];
  if (!runId) throw new Error("A stable run id is required");
  if (action === "status") {
    const run = snapshot.runs[runId];
    if (!run) throw new Error(`Run not found: ${runId}`);
    return notify(ctx, renderRun(run));
  }
  if (action === "pause") return notify(ctx, renderRun(await services.engine.pause(runId)));
  if (action === "resume") return notify(ctx, renderRun(await services.engine.resume(runId)));
  if (action === "stop") return notify(ctx, renderRun(await services.engine.stop(runId)));
  throw new Error("Usage: /neo workflow list|show|run|status|history|pause|resume|stop|add|skip|reorder");
}
async function goalCommand(args: string[], services: NeoServices, ctx: ExtensionCommandContext): Promise<void> {
  const action = args.shift() ?? "list";
  const snapshot = services.store.getSnapshot();
  if (action === "list") return notify(ctx, Object.values(snapshot.goals).map((goal) => `${goal.id} ${goal.status}: ${goal.title}`).join("\n") || "No goals");
  if (action === "create") {
    const title = args.join(" ").trim();
    if (!title) throw new Error("Usage: /neo goal create <title>");
    const now = new Date().toISOString();
    const goal: Goal = { id: stableId("goal"), title, description: title, status: "open", runIds: [], createdAt: now, updatedAt: now };
    await services.store.append("goal.created", { goal });
    return notify(ctx, `Goal created: ${goal.id}`);
  }
  const goal = snapshot.goals[args[0] ?? ""];
  if (!goal) throw new Error("Goal not found");
  if (action === "show") return notify(ctx, JSON.stringify(goal, null, 2));
  if (action === "pause") {
    for (const runId of goal.runIds) {
      const run = services.store.getSnapshot().runs[runId];
      if (run && !["succeeded", "stopped", "failed"].includes(run.status)) await services.engine.pause(runId);
    }
    const paused: Goal = { ...goal, status: "paused", updatedAt: new Date().toISOString() };
    await services.store.append("goal.updated", { goal: paused });
    return notify(ctx, `Goal paused: ${goal.id}`);
  }
  if (action === "resume") {
    const resumed: Goal = { ...goal, status: "open", updatedAt: new Date().toISOString() };
    await services.store.append("goal.updated", { goal: resumed });
    for (const runId of goal.runIds) {
      const run = services.store.getSnapshot().runs[runId];
      if (run?.status === "paused") await services.engine.resume(runId);
    }
    return notify(ctx, `Goal resumed: ${goal.id}`);
  }
  if (action === "close") {
    const closed: Goal = { ...goal, status: "closed", updatedAt: new Date().toISOString() };
    await services.store.append("goal.updated", { goal: closed });
    return notify(ctx, `Goal closed: ${goal.id}`);
  }
  throw new Error("Usage: /neo goal list|create|show|pause|resume|close");
}
async function todoCommand(args: string[], services: NeoServices, ctx: ExtensionCommandContext): Promise<void> {
  const action = args.shift() ?? "list";
  const snapshot = services.store.getSnapshot();
  if (action === "list") return notify(ctx, Object.values(snapshot.todos).map((todo) => `${todo.id} [${todo.status}] [${todo.manual ? "manual" : "workflow"}] ${todo.title}`).join("\n") || "No todos");
  if (action === "add") {
    const title = args.join(" ").trim();
    if (!title) throw new Error("Usage: /neo todo add <title>");
    const now = new Date().toISOString();
    const todo: Todo = { id: stableId("todo"), title, status: "pending", manual: true, evidenceIds: [], createdAt: now, updatedAt: now };
    await services.store.append("todo.created", { todo });
    return notify(ctx, `Todo added: ${todo.id}`);
  }
  const id = args.shift();
  if (!id) throw new Error(`Usage: /neo todo ${action === "show" ? "show <todo-id>" : "done|skip <todo-id>"}`);
  const todo = snapshot.todos[id];
  if (!todo) throw new Error(`Todo not found: ${id}`);
  if (action === "show") return notify(ctx, JSON.stringify(todo, null, 2));
  if (!["done", "skip"].includes(action)) throw new Error("Usage: /neo todo list|add|show|done|skip");
  if (!todo.manual) throw new Error("Workflow-projected todos can only be changed through their workflow node");
  const updated = { ...todo, status: action === "done" ? "done" as const : "skipped" as const, updatedAt: new Date().toISOString() };
  await services.store.append("todo.updated", { todo: updated });
  return notify(ctx, `Todo ${updated.status}: ${todo.id}`);
}
async function agentCommand(args: string[], services: NeoServices, ctx: ExtensionCommandContext): Promise<void> {
  const action = args.shift() ?? "status";
  if (action === "run") {
    let agentType: string | undefined;
    const typeArg = args[0];
    if (typeArg === "--type") {
      args.shift();
      agentType = args.shift();
      if (!agentType) throw new Error("--type requires an agent type");
    } else if (typeArg?.startsWith("--type=")) {
      args.shift();
      agentType = typeArg.slice("--type=".length);
      if (!agentType) throw new Error("--type requires an agent type");
    }
    if (agentType && !getBuiltinAgent(agentType)) throw new Error(`Unknown agent type: "${agentType}". Available: worker, scout.`);
    const prompt = args.join(" ").trim();
    if (!prompt) throw new Error('Usage: /neo agent run [--type <type>] "<prompt>"');
    const activeProfile = services.store.getSnapshot().activeProfile;
    const profile = activeProfile ? await services.profiles.get(activeProfile) : undefined;
    const context = await resolveSkills({
      cwd: ctx.cwd,
      profile,
      skills: [],
      discoverScopes: profile?.discoverScopes ?? [],
      temporary: false,
    }, profile?.recommendedSkills ?? [], profile?.discoverScopes ?? []);
    const now = new Date().toISOString();
    const attempt: NodeAttempt = {
      id: stableId("attempt"),
      runId: stableId("direct-agent"),
      nodeId: "direct",
      status: "running",
      startedAt: now,
      graphRevision: 1,
      evidenceIds: [],
    };
    const child = await services.runtime.spawn({ runId: attempt.runId, nodeId: attempt.nodeId, attempt, prompt, context, agentType });
    return notify(ctx, [
      `Direct child: ${child.id}`,
      `Status: ${child.status}`,
      `Agent type: ${child.agentType ?? "anonymous"}`,
      `Profile: ${profile?.name ?? "(none)"}`,
      child.output ? `\n${child.output}` : child.error ? `\nError: ${child.error}` : "",
    ].filter(Boolean).join("\n"));
  }
  if (action === "list") return notify(ctx, formatBuiltinAgents());
  if (action === "status") return notify(ctx, services.runtime.status().map((child) => `${child.id} [${child.status}] type=${child.agentType ?? "anonymous"} ${child.runId}/${child.nodeId}`).join("\n") || "No child agents");
  if (action === "steer") {
    const id = args.shift();
    const text = args.join(" ");
    if (!id || !text) throw new Error("Usage: /neo agent steer <child-id> <message>");
    await services.runtime.steer(id, text);
    return notify(ctx, `Steered ${id}`);
  }
  throw new Error('Usage: /neo agent run [--type <type>] "<prompt>"|list|status|steer');
}
async function approvalCommand(args: string[], services: NeoServices, ctx: ExtensionCommandContext): Promise<void> { const action = args.shift() ?? "list"; const snapshot = services.store.getSnapshot(); if (action === "list") return notify(ctx, Object.values(snapshot.approvals).filter((approval) => approval.status === "pending").map((approval) => `${approval.id}: ${approval.command} (cwd ${approval.cwd}) impact=${approval.impact}`).join("\n") || "No pending approvals"); const id = args.shift(); if (!id || !["approve", "reject"].includes(action)) throw new Error("Usage: /neo approval list|approve|reject <approval-id>"); const run = await services.engine.approve(id, action === "approve"); return notify(ctx, renderRun(run)); }
function renderDashboard(ctx: ExtensionCommandContext, services: NeoServices): void { const snapshot = services.store.getSnapshot(); const runs = Object.values(snapshot.runs).filter((run) => !["succeeded", "stopped"].includes(run.status)); const goals = Object.values(snapshot.goals).filter((goal) => goal.status === "open"); const todos = Object.values(snapshot.todos); const lines = [`Profile: ${snapshot.activeProfile ?? "(none)"}`, `Goals: ${goals.length} open`, `Runs: ${runs.length} active`, `Todos: ${todos.filter((todo) => todo.status === "done").length}/${todos.length} done`, `Approvals: ${Object.values(snapshot.approvals).filter((approval) => approval.status === "pending").length} pending`]; ctx.ui.notify(lines.join(" | "), "info"); }
function renderHistory(run: import("./domain/types.js").WorkflowRun, events: readonly import("./domain/types.js").NeoEvent[]): string {
  const relevant = events.filter((event) => event.payload.runId === run.id || (event.payload.run as { id?: string } | undefined)?.id === run.id || (event.payload.approval as { runId?: string } | undefined)?.runId === run.id);
  const initial = relevant.find((event) => event.type === "run.created")?.payload.run as import("./domain/types.js").WorkflowRun | undefined;
  const lines = [
    `Run ${run.id} ${run.workflowName}@${run.workflowVersion} [${run.status}] revision ${run.graph.revision}`,
    `Planned route: ${run.graph.plannedRoute.join(" -> ") || "(empty)"}`,
    `Actual route: ${run.graph.actualRoute.join(" -> ") || "(none)"}`,
  ];
  if (initial) lines.push(`Initial route: ${initial.graph.plannedRoute.join(" -> ") || "(empty)"}`);
  const summaries: string[] = [];
  const attemptStatuses = new Map<string, string>();
  for (const event of relevant) {
    if (event.type === "graph.mutated") {
      const mutation = event.payload.mutation as { type?: string; reason?: string; nodeId?: string; nodeIds?: string[]; node?: { id?: string }; nodes?: Array<{ id?: string }>; order?: string[] } | undefined;
      const detail = mutation?.type === "split" ? `${mutation.nodeId} -> ${(mutation.nodes ?? []).map((node) => node.id).join(",")}` : mutation?.type === "merge" ? `${(mutation.nodeIds ?? []).join(",")} -> ${mutation.node?.id ?? "?"}` : mutation?.type === "reorder" ? (mutation.order ?? []).join(" -> ") : mutation?.nodeId ?? mutation?.node?.id ?? "";
      summaries.push(`${event.timestamp} graph.mutated ${mutation?.type ?? "unknown"}${detail ? ` (${detail})` : ""}${mutation?.reason ? `: ${mutation.reason}` : ""}`);
    } else if (event.type === "approval.created" || event.type === "approval.updated") {
      const approval = event.payload.approval as { id?: string; nodeId?: string; status?: string; decidedBy?: string } | undefined;
      summaries.push(`${event.timestamp} ${event.type} ${approval?.id ?? "?"} node=${approval?.nodeId ?? "?"} [${approval?.status ?? "unknown"}]${approval?.decidedBy ? ` by ${approval.decidedBy}` : ""}`);
    } else if (event.type === "agent.event" && event.payload.event === "tool_call") {
      const tool = event.payload.tool as { name?: string; parameters?: Record<string, unknown>; resultStatus?: string } | undefined;
      summaries.push(`${event.timestamp} agent.tool ${tool?.name ?? "?"} [${tool?.resultStatus ?? "unknown"}] ${JSON.stringify(tool?.parameters ?? {})}`);
    } else if (event.type === "run.created" || event.type === "run.updated") {
      const eventRun = event.payload.run as import("./domain/types.js").WorkflowRun | undefined;
      for (const attempt of Object.values(eventRun?.attempts ?? {})) {
        const previous = attemptStatuses.get(attempt.id);
        if (!previous) summaries.push(`${event.timestamp} attempt.started ${attempt.id} node=${attempt.nodeId} [${attempt.status}]`);
        if (previous && previous !== attempt.status) summaries.push(`${event.timestamp} attempt.${attempt.status} ${attempt.id} node=${attempt.nodeId}`);
        attemptStatuses.set(attempt.id, attempt.status);
      }
    }
  }
  return [...lines, "Events:", ...(summaries.length ? summaries : ["(none)"])].join("\n");
}
function renderRun(run: import("./domain/types.js").WorkflowRun | undefined): string {
  if (!run) return "Run not found";
  const nodes = Object.values(run.graph.nodes);
  const summary = `${run.id} ${run.workflowName}@${run.workflowVersion} [${run.status}] ${nodes.filter((node) => node.status === "succeeded").length}/${nodes.length} nodes, revision ${run.graph.revision}${run.goalId ? `, goal: ${run.goalId}` : ""}${run.pendingApprovalIds.length ? `, approvals: ${run.pendingApprovalIds.join(", ")}` : ""}`;
  const route = `Route: ${run.graph.plannedRoute.join(" -> ")}`;
  const details = run.graph.plannedRoute.map((nodeId) => {
    const node = run.graph.nodes[nodeId];
    if (!node) return `${nodeId} [missing]`;
    const mutation = node.metadata?.mutationReason ? ` (added: ${node.metadata.mutationReason})` : node.skipReason ? ` (${node.skipReason})` : "";
    return `${node.id} [${node.status}] ${node.title}${mutation}`;
  });
  return [summary, route, ...details].join("\n");
}
function parseRunOptions(args: readonly string[]): { goalId?: string; inputs: Record<string, string> } {
  let goalId: string | undefined;
  const inputArgs: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("goal=") || arg.startsWith("--goal=")) {
      if (goalId !== undefined) throw new Error("Goal may only be specified once");
      goalId = arg.slice(arg.indexOf("=") + 1);
      if (!goalId) throw new Error("Goal id cannot be empty");
    } else inputArgs.push(arg);
  }
  return { goalId, inputs: parseAssignments(inputArgs) };
}
function parseAssignments(args: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of args) {
    const index = pair.indexOf("=");
    if (index > 0) result[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return result;
}
function commaList(value: string | undefined): string[] | undefined { return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : undefined; }
function numericRevision(value: string | undefined, fallback: number): number { if (value === undefined) return fallback; const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid graph revision: ${value}`); return parsed; }
export function createNeoTool(ensure: (cwd: string) => Promise<NeoServices>) {
  const actionSchema = Type.Object({
    area: Type.Union([Type.Literal("status"), Type.Literal("workflow"), Type.Literal("goal"), Type.Literal("todo"), Type.Literal("agent")]),
    operation: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    type: Type.Optional(Type.String()),
    agentType: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    goalId: Type.Optional(Type.String()),
    todoId: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    prompt: Type.Optional(Type.String()),
    inputs: Type.Optional(Type.Record(Type.String(), Type.String())),
    expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
    mutation: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  });
  return defineTool({
    name: "neo",
    label: "Neo Control",
    description: "Control Neo through status, workflow run/status/mutate, goal, and todo actions using a structured action or command. Natural language may supplement or adjust the requested fields, but it cannot bypass high-risk approval.",
    promptSnippet: "Inspect or operate Neo state through its shared workflow services.",
    parameters: Type.Object({ command: Type.Optional(Type.String()), action: Type.Optional(actionSchema) }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) => {
      const services = await ensure(ctx.cwd);
      if (params.action?.area === "workflow" && params.action.operation === "mutate") {
        const runId = params.action.runId;
        const mutation = params.action.mutation as unknown as GraphMutation | undefined;
        if (!runId || !mutation) return neoToolResult({ status: "error", reason: "workflow mutate requires runId and mutation" });
        try {
          const run = await services.engine.mutateGraph(runId, mutation, params.action.expectedRevision);
          return neoToolResult({ status: "ok", operation: "workflow.mutate", runId, output: renderRun(run), run });
        } catch (error) {
          return neoToolResult({ status: "error", operation: "workflow.mutate", reason: error instanceof Error ? error.message : String(error) });
        }
      }
      const command = params.command?.trim() || actionCommand(params.action);
      if (!command) return neoToolResult({ status: "error", reason: "Provide command or structured action" });
      const normalized = command.replace(/^\/neo\s*/, "");
      const root = splitArgs(normalized)[0];
      if (!root || !["status", "workflow", "goal", "todo", "agent"].includes(root)) return neoToolResult({ status: "error", reason: "neo supports status, workflow, goal, todo, and agent actions only" });
      const messages: Array<{ text: string; level: string }> = [];
      const commandContext = {
        ...ctx,
        ui: { ...ctx.ui, notify: (text: string, level?: string) => { messages.push({ text, level: level ?? "info" }); } },
      } as unknown as ExtensionCommandContext;
      await handleNeoCommand(normalized, services, commandContext);
      const last = messages.at(-1);
      return neoToolResult({ status: last?.level === "error" ? "error" : "ok", command: normalized, output: last?.text ?? "" });
    },
  });
}

function actionCommand(action: { area: string; operation?: string; name?: string; type?: string; agentType?: string; runId?: string; goalId?: string; todoId?: string; title?: string; reason?: string; prompt?: string; inputs?: Record<string, string> } | undefined): string | undefined {
  if (!action) return undefined;
  if (action.area === "status") return "status";
  if (action.area === "workflow") {
    const operation = action.operation ?? "status";
    if (operation === "run" && action.name) return ["workflow", "run", action.name, ...(action.goalId ? [`goal=${action.goalId}`] : []), ...Object.entries(action.inputs ?? {}).map(([key, value]) => `${key}=${value}`)].join(" ");
    if (action.runId && ["status", "history", "pause", "resume", "stop"].includes(operation)) return `workflow ${operation} ${action.runId}`;
  }
  if (action.area === "goal") {
    if (action.operation === "list") return "goal list";
    if (action.operation === "create" && action.title) return `goal create ${quoteArg(action.title)}`;
    if (action.goalId && ["show", "pause", "resume", "close"].includes(action.operation ?? "")) return `goal ${action.operation} ${action.goalId}`;
  }
  if (action.area === "agent") {
    if (action.operation === "run" && action.prompt) {
      const type = action.type ?? action.agentType ?? action.name;
      return ["agent", "run", ...(type ? ["--type", quoteArg(type)] : []), quoteArg(action.prompt)].join(" ");
    }
    if (action.operation === "status" || action.operation === "list") return "agent status";
    if (action.operation === "steer" && action.runId && action.prompt) return `agent steer ${action.runId} ${quoteArg(action.prompt)}`;
  }
  return undefined;
}

function quoteArg(value: string): string { return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`; }
function neoToolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  };
}
function notify(ctx: ExtensionCommandContext, text: string): void { ctx.ui.notify(text, "info"); }
