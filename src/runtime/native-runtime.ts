import { dirname, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  resolveCliModel,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getBuiltinAgent, buildBuiltinAgentPrompt, type NeoAgentConfig } from "../agents/registry.js";
import type { ExecutionContext, GraphMutation, NodeAttempt, WorkflowNode, WorkflowRun } from "../domain/types.js";
import { SkillDiscovery } from "../skills/skill-discovery.js";

export type ChildStatus = "queued" | "running" | "stopped" | "failed" | "succeeded";

export interface ChildSessionRecord {
  id: string;
  runId: string;
  nodeId: string;
  attemptId: string;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  agentType?: string;
  config?: NeoAgentConfig;
  status: ChildStatus;
  output: string;
  error?: string;
  events: string[];
  turnCount: number;
  maxTurns?: number;
  useParentSkills?: "*";
  inheritedSkillCount?: number;
}

export type WorkflowMutationHandler = (mutation: GraphMutation, expectedRevision?: number) => Promise<WorkflowRun>;

export interface NativeSpawnInput {
  runId: string;
  nodeId: string;
  attempt: NodeAttempt;
  prompt: string;
  context: ExecutionContext;
  model?: CreateAgentSessionOptions["model"];
  agentType?: string;
  config?: NeoAgentConfig;
  mutateWorkflow?: WorkflowMutationHandler;
}

export type SessionFactory = (options: CreateAgentSessionOptions) => Promise<{ session: AgentSession }>;
export interface ToolProvenance {
  name: string;
  parameters: Record<string, unknown>;
  resultStatus: string;
  useParentSkills: "*" | null;
  inheritedSkillCount: number;
}

export interface NativeRuntimeOptions {
  cwd: string;
  stateDirectory: string;
  concurrency?: number;
  modelRuntime?: ModelRuntime;
  modelResolver?: (model: string, modelRuntime: ModelRuntime) => CreateAgentSessionOptions["model"] | undefined | Promise<CreateAgentSessionOptions["model"]>;
  sessionFactory?: SessionFactory;
  onEvent?: (child: ChildSessionRecord, event: AgentSessionEvent) => void;
  onToolCall?: (child: ChildSessionRecord, provenance: ToolProvenance) => void;
}

interface ChildState {
  record: ChildSessionRecord;
  context: ExecutionContext;
  model?: CreateAgentSessionOptions["model"];
  agentType?: string;
  config?: NeoAgentConfig;
  mutateWorkflow?: WorkflowMutationHandler;
  session?: AgentSession;
  unsubscribe?: () => void;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
}

export class NativeAgentRuntime {
  private readonly children = new Map<string, ChildState>();
  private readonly waiters: Waiter[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private active = 0;
  private disposed = false;
  private modelRuntime?: ModelRuntime;
  private readonly concurrency: number;
  private readonly sessionFactory: SessionFactory;

  constructor(private readonly options: NativeRuntimeOptions) {
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.sessionFactory = options.sessionFactory ?? ((input) => createAgentSession(input));
    this.modelRuntime = options.modelRuntime;
  }

  async spawn(input: NativeSpawnInput): Promise<ChildSessionRecord> {
    this.assertUsable();
    const id = `neo_child_${input.attempt.id}`;
    if (this.children.has(id)) throw new Error(`Child session already exists: ${id}`);
    const config = input.config ?? (input.agentType ? this.requireAgent(input.agentType) : undefined);
    const agentType = input.agentType ?? config?.name;
    const child: ChildState = {
      record: {
        id,
        runId: input.runId,
        nodeId: input.nodeId,
        attemptId: input.attempt.id,
        sessionId: "",
        cwd: input.context.cwd,
        agentType,
        config,
        status: "queued",
        output: "",
        events: [],
        turnCount: 0,
        maxTurns: config?.maxTurns,
        useParentSkills: config?.useParentSkills ?? effectiveParentSkills(input.context),
        inheritedSkillCount: config?.useParentSkills === "*"
          ? input.context.skills.length
          : config
            ? 0
            : (input.context.inheritedSkillCount ?? 0),
      },
      context: structuredClone(input.context),
      model: input.model,
      agentType,
      config,
      mutateWorkflow: input.mutateWorkflow,
    };
    this.children.set(id, child);
    await this.track(this.withSlot(child, async () => {
      await this.openSession(child, SessionManager.create(child.context.cwd, join(this.options.stateDirectory, "sessions")));
      await this.drive(child, input.prompt);
    }));
    return this.cloneRecord(child.record);
  }

  async prompt(childId: string, text: string): Promise<ChildSessionRecord> {
    const child = this.require(childId);
    if (!child.session) throw new Error(`Child session is not open: ${childId}`);
    await this.track(this.withSlot(child, () => this.drive(child, text)));
    return this.cloneRecord(child.record);
  }

  async steer(childId: string, text: string): Promise<void> {
    const session = this.requireRunningSession(childId);
    await session.steer(text);
  }

  async followUp(childId: string, text: string): Promise<void> {
    const session = this.requireRunningSession(childId);
    await session.followUp(text);
  }

  async stop(childId: string): Promise<void> {
    const child = this.require(childId);
    if (isTerminal(child.record.status)) return;
    child.record.status = "stopped";
    child.record.error = "Stopped";
    await child.session?.abort();
  }

  async resume(childId: string, prompt = "Resume the previous task from its persisted context."): Promise<ChildSessionRecord> {
    this.assertUsable();
    const child = this.require(childId);
    if (!child.record.sessionFile) throw new Error("Child has no persistent session file");
    await this.track(this.withSlot(child, async () => {
      this.detachSession(child);
      child.record.output = "";
      child.record.error = undefined;
      const manager = SessionManager.open(child.record.sessionFile as string, dirname(child.record.sessionFile as string), child.context.cwd);
      await this.openSession(child, manager);
      await this.drive(child, prompt);
    }));
    return this.cloneRecord(child.record);
  }

  status(childId?: string): ChildSessionRecord[] {
    if (childId) return [this.cloneRecord(this.require(childId).record)];
    return [...this.children.values()].map(({ record }) => this.cloneRecord(record));
  }

  async disposeChild(childId: string): Promise<void> {
    const child = this.require(childId);
    if (!isTerminal(child.record.status)) await this.stop(childId);
    this.detachSession(child);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error("NativeAgentRuntime is disposed");
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    await Promise.all([...this.children.values()].map(async (child) => {
      if (!isTerminal(child.record.status)) child.record.status = "stopped";
      await child.session?.abort().catch(() => undefined);
    }));
    await Promise.allSettled([...this.inFlight]);
    for (const child of this.children.values()) this.detachSession(child);
    this.children.clear();
  }

  private async openSession(child: ChildState, manager: SessionManager): Promise<void> {
    const loader = await this.createLoader(child.context, child.config);
    const modelRuntime = this.modelRuntime ??= await ModelRuntime.create();
    const model = child.model ?? await this.resolveModel(child.config?.model, modelRuntime);
    const customTools = [
      this.contextTool(child.context),
      this.skillSearchTool(child.context, child),
      this.skillLoadTool(child.context, child),
      this.workflowMutationTool(child),
    ];
    const tools = [...new Set([...(child.config?.tools ?? []), ...customTools.map((tool) => tool.name)])];
    const { session } = await this.sessionFactory({
      cwd: child.context.cwd,
      model,
      thinkingLevel: child.config?.thinking,
      modelRuntime,
      resourceLoader: loader,
      sessionManager: manager,
      noTools: child.config ? undefined : "all",
      customTools,
      tools,
    });
    child.session = session;
    child.record.sessionId = session.sessionId;
    child.record.sessionFile = session.sessionFile;
    child.unsubscribe = session.subscribe((event) => this.handleEvent(child, event));
  }

  private async drive(child: ChildState, prompt: string): Promise<void> {
    if (!child.session) throw new Error(`Child session is not open: ${child.record.id}`);
    child.record.status = "running";
    child.record.error = undefined;
    try {
      await child.session.prompt(prompt, child.session.isStreaming ? { streamingBehavior: "followUp" } : undefined);
      if (isStopped(child.record)) return;
      const error = sessionError(child.session);
      child.record.status = error ? "failed" : "succeeded";
      child.record.error = error;
      if (error && !child.record.output) child.record.output = error;
    } catch (error) {
      if (isStopped(child.record)) return;
      child.record.status = "failed";
      child.record.error = error instanceof Error ? error.message : String(error);
      if (!child.record.output) child.record.output = child.record.error;
    }
  }

  private async resolveModel(model: string | undefined, modelRuntime: ModelRuntime): Promise<CreateAgentSessionOptions["model"] | undefined> {
    if (!model) return undefined;
    if (this.options.modelResolver) return this.options.modelResolver(model, modelRuntime);
    try {
      return resolveCliModel({ cliModel: model, modelRuntime }).model;
    } catch {
      return undefined;
    }
  }

  private async createLoader(context: ExecutionContext, config?: NeoAgentConfig): Promise<ResourceLoader> {
    const selected = (config
      ? config.useParentSkills === "*" ? context.skills : []
      : context.skills)
      .filter((skill) => skill.status === "loaded" && skill.source)
      .map((skill) => ({
        name: skill.name,
        description: `Neo-selected skill ${skill.name}`,
        filePath: skill.source as string,
        baseDir: dirname(skill.source as string),
        source: "custom" as const,
        sourceInfo: { path: skill.source as string, source: "neo", scope: "temporary" as const, origin: "top-level" as const },
        disableModelInvocation: false,
      }));
    const loader = new DefaultResourceLoader({
      cwd: context.cwd,
      agentDir: join(this.options.stateDirectory, "agent"),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => config
        ? buildBuiltinAgentPrompt(config, context.cwd)
        : "You are a Neo child agent. Work only on the assigned node and report evidence and uncertainty.",
      appendSystemPromptOverride: (base) => base,
      skillsOverride: () => ({ skills: selected, diagnostics: [] }),
      agentsFilesOverride: () => ({
        agentsFiles: context.profile ? [{ path: context.profile.sourcePath, content: context.profile.description }] : [],
      }),
    });
    await loader.reload();
    return loader;
  }

  private contextTool(context: ExecutionContext) {
    return defineTool({
      name: "neo_context",
      label: "Neo Context",
      description: "Return the selected Neo execution context and currently loaded skill statuses.",
      promptSnippet: "Inspect the current workflow context and selected skills.",
      parameters: Type.Object({}),
      execute: async () => toolResult({
        cwd: context.cwd,
        workflow: context.workflowName,
        temporary: context.temporary,
        useParentSkills: effectiveParentSkills(context) ?? null,
        inheritedSkillCount: context.inheritedSkillCount ?? 0,
        discoverScopes: context.discoverScopes ?? [],
        skills: context.skills.map((skill) => ({ name: skill.name, status: skill.status })),
      }),
    });
  }

  private skillSearchTool(context: ExecutionContext, child: ChildState) {
    return defineTool({
      name: "neo_skill_search",
      label: "Neo Skill Search",
      description: "Search configured Neo skill scopes by name. This does not enable tools or permissions.",
      promptSnippet: "Search configured skill scopes when the assigned task needs specialized guidance.",
      parameters: Type.Object({ query: Type.String({ description: "Skill name or substring; use an empty string to list all skills" }) }),
      execute: async (_toolCallId, params) => {
        try {
          const skills = await new SkillDiscovery(context.cwd).search(params.query, context.discoverScopes ?? []);
          this.reportTool(child, "neo_skill_search", params, "succeeded");
          return toolResult({ query: params.query, skills });
        } catch (error) {
          this.reportTool(child, "neo_skill_search", params, "error");
          throw error;
        }
      },
    });
  }

  private skillLoadTool(context: ExecutionContext, child: ChildState) {
    return defineTool({
      name: "neo_skill_load",
      label: "Neo Skill Load",
      description: "Load one named skill from configured scopes and return its SKILL.md content. Missing skills are a non-fatal fallback and loading never enables additional tools or permissions.",
      promptSnippet: "Load a discovered skill for instructions; continue with existing knowledge when it is missing.",
      parameters: Type.Object({ name: Type.String({ minLength: 1 }) }),
      execute: async (_toolCallId, params) => {
        try {
          const result = (await new SkillDiscovery(context.cwd).discover([params.name], context.discoverScopes ?? []))[0];
          if (!result) {
            this.reportTool(child, "neo_skill_load", params, "missing");
            return toolResult({ name: params.name, status: "missing", reason: "Skill discovery returned no result", permissionsChanged: false });
          }
          const index = context.skills.findIndex((skill) => skill.name === params.name);
          if (index >= 0) context.skills[index] = result;
          else context.skills.push(result);
          this.reportTool(child, "neo_skill_load", params, result.status);
          return toolResult({ ...result, permissionsChanged: false, fallback: result.status !== "loaded" ? "Continue using existing knowledge." : undefined });
        } catch (error) {
          this.reportTool(child, "neo_skill_load", params, "error");
          throw error;
        }
      },
    });
  }

  private workflowMutationTool(child: ChildState) {
    const nodeSchema = Type.Object({
      id: Type.String({ minLength: 1 }),
      kind: Type.Union([Type.Literal("agent"), Type.Literal("shell"), Type.Literal("approval"), Type.Literal("condition"), Type.Literal("parallel"), Type.Literal("artifact"), Type.Literal("receipt")]),
      title: Type.String({ minLength: 1 }),
      dependsOn: Type.Optional(Type.Array(Type.String())),
      risk: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")])),
      approval: Type.Optional(Type.Boolean()),
      agent: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      args: Type.Optional(Type.Array(Type.String())),
      cwd: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      timeoutMs: Type.Optional(Type.Number()),
      condition: Type.Optional(Type.String()),
      branches: Type.Optional(Type.Array(Type.String())),
      join: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("any")])),
      path: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      evidenceKind: Type.Optional(Type.Union([Type.Literal("shell"), Type.Literal("test"), Type.Literal("health")])),
      metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
    });
    return defineTool({
      name: "neo_workflow_mutate",
      label: "Neo Workflow Mutate",
      description: "Mutate this workflow run with graph-revision CAS. Supports add, skip, reorder, split, and merge.",
      promptSnippet: "Adapt the current workflow with durable add, skip, reorder, split, or merge mutations when new work is discovered.",
      parameters: Type.Object({
        operation: Type.Union([Type.Literal("add"), Type.Literal("skip"), Type.Literal("reorder"), Type.Literal("split"), Type.Literal("merge")]),
        reason: Type.String({ minLength: 1 }),
        expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
        node: Type.Optional(nodeSchema),
        nodes: Type.Optional(Type.Array(nodeSchema)),
        nodeId: Type.Optional(Type.String()),
        nodeIds: Type.Optional(Type.Array(Type.String())),
        order: Type.Optional(Type.Array(Type.String())),
      }),
      execute: async (_toolCallId, params) => {
        if (!child.mutateWorkflow) {
          this.reportTool(child, "neo_workflow_mutate", params, "unsupported");
          return toolResult({ status: "unsupported", reason: "This child is not attached to a mutable workflow run." });
        }
        let mutation: GraphMutation;
        if (params.operation === "add") {
          if (!params.node) return toolResult({ status: "invalid", reason: "add requires node" });
          mutation = { type: "add", node: params.node as WorkflowNode, reason: params.reason };
        } else if (params.operation === "skip") {
          if (!params.nodeId) return toolResult({ status: "invalid", reason: "skip requires nodeId" });
          mutation = { type: "skip", nodeId: params.nodeId, reason: params.reason };
        } else if (params.operation === "reorder") {
          if (!params.order?.length) return toolResult({ status: "invalid", reason: "reorder requires order" });
          mutation = { type: "reorder", order: params.order, reason: params.reason };
        } else if (params.operation === "split") {
          if (!params.nodeId) return toolResult({ status: "invalid", reason: "split requires nodeId" });
          if (!params.nodes || params.nodes.length < 2) return toolResult({ status: "invalid", reason: "split requires at least two nodes" });
          mutation = { type: "split", nodeId: params.nodeId, nodes: params.nodes as WorkflowNode[], reason: params.reason };
        } else {
          if (!params.nodeIds || params.nodeIds.length < 2) return toolResult({ status: "invalid", reason: "merge requires at least two nodeIds" });
          if (!params.node) return toolResult({ status: "invalid", reason: "merge requires node" });
          mutation = { type: "merge", nodeIds: params.nodeIds, node: params.node as WorkflowNode, reason: params.reason };
        }
        try {
          const run = await child.mutateWorkflow(mutation, params.expectedRevision);
          this.reportTool(child, "neo_workflow_mutate", params, "applied");
          return toolResult({
            status: "applied",
            runId: run.id,
            graphRevision: run.graph.revision,
            plannedRoute: run.graph.plannedRoute,
            nodes: Object.values(run.graph.nodes).map((node) => ({ id: node.id, title: node.title, status: node.status })),
          });
        } catch (error) {
          this.reportTool(child, "neo_workflow_mutate", params, "error");
          return toolResult({ status: "error", reason: error instanceof Error ? error.message : String(error) });
        }
      },
    });
  }

  private reportTool(child: ChildState, name: string, parameters: unknown, resultStatus: string): void {
    const summary = summarizeToolParams(parameters);
    this.options.onToolCall?.(this.cloneRecord(child.record), {
      name,
      parameters: isRecord(summary) ? summary : { value: summary },
      resultStatus,
      useParentSkills: child.config?.useParentSkills ?? effectiveParentSkills(child.context) ?? null,
      inheritedSkillCount: child.config?.useParentSkills === "*"
        ? child.context.skills.length
        : child.config
          ? 0
          : (child.context.inheritedSkillCount ?? 0),
    });
  }

  private requireAgent(name: string): NeoAgentConfig {
    const config = getBuiltinAgent(name);
    if (config) return config;
    throw new Error(`Unknown agent type: "${name}". Available: worker, scout.`);
  }

  private handleEvent(child: ChildState, event: AgentSessionEvent): void {
    const record = child.record;
    record.events.push(event.type);
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") record.output += event.assistantMessageEvent.delta;
    if (event.type === "turn_end") {
      record.turnCount += 1;
      if (record.maxTurns !== undefined && record.turnCount >= record.maxTurns && child.session?.isStreaming) {
        record.status = "stopped";
        record.error = `Agent reached max turns (${record.maxTurns})`;
        void child.session.abort();
      }
    }
    this.options.onEvent?.(this.cloneRecord(record), event);
  }

  private async withSlot(child: ChildState, task: () => Promise<void>): Promise<void> {
    const release = await this.acquire();
    try {
      if (child.record.status === "stopped" || this.disposed) return;
      await task();
    } finally {
      release();
    }
  }

  private acquire(): Promise<() => void> {
    this.assertUsable();
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve(this.releaseFactory());
    }
    return new Promise<() => void>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private releaseFactory(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const waiter = this.waiters.shift();
      if (!waiter) return;
      if (this.disposed) waiter.reject(new Error("NativeAgentRuntime is disposed"));
      else {
        this.active += 1;
        waiter.resolve(this.releaseFactory());
      }
    };
  }

  private async track(promise: Promise<void>): Promise<void> {
    this.inFlight.add(promise);
    try { await promise; } finally { this.inFlight.delete(promise); }
  }

  private detachSession(child: ChildState): void {
    child.unsubscribe?.();
    child.unsubscribe = undefined;
    child.session?.dispose();
    child.session = undefined;
  }

  private require(id: string): ChildState {
    const child = this.children.get(id);
    if (!child) throw new Error(`Unknown child session: ${id}`);
    return child;
  }

  private requireRunningSession(id: string): AgentSession {
    const child = this.require(id);
    if (child.record.status !== "running" || !child.session) throw new Error(`Child session is not running: ${id}`);
    return child.session;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("NativeAgentRuntime is disposed");
  }

  private cloneRecord(record: ChildSessionRecord): ChildSessionRecord {
    return structuredClone(record);
  }
}

function effectiveParentSkills(context: ExecutionContext): "*" | undefined {
  if (context.temporary) return undefined;
  return context.useParentSkills ?? context.profile?.useParentSkills;
}

function summarizeToolParams(value: unknown, key?: string, depth = 0): unknown {
  if (key && /(secret|token|password|credential|api.?key)/i.test(key)) return "[redacted]";
  if (typeof value === "string") return key && /prompt|content/i.test(key) ? `[${key} length=${value.length}]` : value.length > 160 ? `${value.slice(0, 160)}...[truncated]` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= 3) return "[summary truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => summarizeToolParams(item, key, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 40).map(([entryKey, entryValue]) => [entryKey, summarizeToolParams(entryValue, entryKey, depth + 1)]));
  return `[${typeof value}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  };
}

function isStopped(record: ChildSessionRecord): boolean {
  return record.status === "stopped";
}

function isTerminal(status: ChildStatus): boolean {
  return status === "stopped" || status === "failed" || status === "succeeded";
}

function sessionError(session: AgentSession): string | undefined {
  if (session.agent.state.errorMessage) return session.agent.state.errorMessage;
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index] as unknown;
    if (!message || typeof message !== "object") continue;
    const candidate = message as Record<string, unknown>;
    if (candidate.role !== "assistant") continue;
    if (candidate.stopReason === "error" || candidate.stopReason === "aborted") {
      return typeof candidate.errorMessage === "string" ? candidate.errorMessage : String(candidate.stopReason);
    }
    break;
  }
  return undefined;
}
