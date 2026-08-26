import { createHash } from "node:crypto";
import type {
  Approval,
  Evidence,
  ExecutionContext,
  GraphMutation,
  GraphNode,
  Goal,
  NodeAttempt,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRun,
} from "../domain/types.js";
import { commandDetails, makeAttempt, needsApproval } from "../nodes/policy.js";
import { ShellExecutor } from "../nodes/shell-node.js";
import { NativeAgentRuntime } from "../runtime/native-runtime.js";
import { NeoStateStore, stableId } from "../state/store.js";
import { createGraph, MutableGraph } from "./graph.js";
import { WorkflowMutationService } from "./mutation-service.js";
import type { WorkflowLoader } from "./workflow-loader.js";

export interface WorkflowEngineOptions {
  cwd: string;
  store: NeoStateStore;
  loader: WorkflowLoader;
  runtime: NativeAgentRuntime;
  shell: ShellExecutor;
  context: (workflow: WorkflowDefinition, run: WorkflowRun) => Promise<ExecutionContext>;
}
export interface RunOptions { inputs?: Record<string, string>; goalId?: string; }

export class WorkflowEngine {
  private readonly mutations: WorkflowMutationService;

  constructor(private readonly options: WorkflowEngineOptions) {
    this.mutations = new WorkflowMutationService(options.store);
  }

  async createRun(name: string, runOptions: RunOptions = {}): Promise<WorkflowRun> {
    const workflow = await this.options.loader.get(name);
    if (!workflow) throw new Error(`Workflow not found: ${name}`);
    const linkedGoal = runOptions.goalId ? this.options.store.getSnapshot().goals[runOptions.goalId] : undefined;
    if (runOptions.goalId && !linkedGoal) throw new Error(`Goal not found: ${runOptions.goalId}`);
    if (linkedGoal?.status === "closed") throw new Error(`Cannot attach a run to closed goal: ${linkedGoal.id}`);
    const inputs: Record<string, string> = { ...runOptions.inputs };
    for (const input of workflow.inputs) {
      if (input.required && !inputs[input.name] && input.default === undefined) throw new Error(`Missing workflow input: ${input.name}`);
      if (!inputs[input.name] && input.default !== undefined) inputs[input.name] = input.default;
    }
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      id: stableId("run"),
      workflowName: workflow.name,
      workflowVersion: workflow.version,
      goalId: runOptions.goalId,
      status: linkedGoal?.status === "paused" ? "paused" : "pending",
      inputs,
      graph: createGraph(workflow),
      attempts: {},
      pendingApprovalIds: [],
      artifactIds: [],
      receiptIds: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.options.store.append("run.created", { run });
    if (run.goalId) {
      const goal = this.options.store.getSnapshot().goals[run.goalId];
      if (goal) await this.options.store.append("goal.updated", { goal: { ...goal, runIds: [...new Set([...goal.runIds, run.id])], updatedAt: now } satisfies Goal });
    }
    return run;
  }

  async run(runId: string): Promise<WorkflowRun> {
    let run = this.requireRun(runId);
    if (["succeeded", "stopped", "paused"].includes(run.status)) return run;
    if (run.pendingApprovalIds.length) return this.saveRun({ ...run, status: "blocked" });
    run = await this.saveRun({ ...run, status: "running", error: undefined });
    const workflow = await this.options.loader.get(run.workflowName);
    if (!workflow || workflow.version !== run.workflowVersion) throw new Error(`Pinned workflow not found: ${run.workflowName}@${run.workflowVersion}`);
    const context = await this.options.context(workflow, run);

    while (run.status === "running") {
      const ready = new MutableGraph(run.graph).ready();
      if (!ready.length) break;
      for (const node of ready) {
        run = await this.executeNode(run, node, workflow, context);
        if (run.status === "blocked" || run.status === "stopped" || run.status === "paused") return run;
      }
    }

    const nodes = Object.values(run.graph.nodes);
    const remaining = nodes.some((node) => node.status === "pending" || node.status === "running");
    const failed = nodes.some((node) => node.status === "failed" || node.status === "unknown_effect");
    return this.saveRun({
      ...run,
      status: run.pendingApprovalIds.length ? "blocked" : failed ? "failed" : remaining ? "blocked" : "succeeded",
      error: failed ? run.error ?? "One or more workflow nodes failed" : undefined,
    });
  }

  async pause(runId: string): Promise<WorkflowRun> {
    const run = this.requireRun(runId);
    if (["succeeded", "stopped", "failed"].includes(run.status)) return run;
    return this.saveRun({ ...run, status: "paused" });
  }

  async stop(runId: string): Promise<WorkflowRun> {
    const run = this.requireRun(runId);
    for (const attempt of Object.values(run.attempts)) {
      if (attempt.status === "running") await this.options.runtime.stop(`neo_child_${attempt.id}`).catch(() => undefined);
    }
    for (const node of Object.values(run.graph.nodes)) if (node.status === "running") node.status = "failed";
    for (const attempt of Object.values(run.attempts)) {
      if (attempt.status === "running") {
        attempt.status = "failed";
        attempt.error = "Workflow stopped";
        attempt.finishedAt = new Date().toISOString();
      }
    }
    return this.saveRun({ ...run, status: "stopped" });
  }

  async resume(runId: string): Promise<WorkflowRun> {
    const run = this.requireRun(runId);
    if (run.status === "stopped" || run.status === "succeeded") return run;
    const linkedGoal = run.goalId ? this.options.store.getSnapshot().goals[run.goalId] : undefined;
    if (linkedGoal?.status === "paused") return this.saveRun({ ...run, status: "paused" });
    if (run.pendingApprovalIds.length) return this.saveRun({ ...run, status: "blocked" });
    for (const node of Object.values(run.graph.nodes)) {
      if (node.status === "failed") node.status = "pending";
    }
    run.status = "pending";
    run.error = undefined;
    await this.saveRun(run);
    return this.run(run.id);
  }

  async approve(approvalId: string, approved: boolean, decidedBy = "user"): Promise<WorkflowRun> {
    const snapshot = this.options.store.getSnapshot();
    const approval = snapshot.approvals[approvalId];
    if (!approval) throw new Error(`Approval not found: ${approvalId}`);
    if (approval.status !== "pending") throw new Error(`Approval already ${approval.status}: ${approvalId}`);
    const updated: Approval = {
      ...approval,
      status: approved ? "approved" : "rejected",
      decidedBy,
      decidedAt: new Date().toISOString(),
    };
    await this.options.store.append("approval.updated", { approvalId, approval: updated });

    const run = this.requireRun(approval.runId);
    const remainPaused = run.status === "paused" || (run.goalId ? this.options.store.getSnapshot().goals[run.goalId]?.status === "paused" : false);
    const pending = run.pendingApprovalIds.filter((id) => id !== approvalId);
    const node = run.graph.nodes[approval.nodeId];
    const blockedAttempt = run.attempts[approval.attemptId];
    if (!node || !blockedAttempt) throw new Error(`Approval target is missing: ${approvalId}`);
    if (approved) {
      node.status = "pending";
      run.status = remainPaused ? "paused" : "pending";
    } else {
      node.status = "failed";
      blockedAttempt.status = "failed";
      blockedAttempt.error = "Approval rejected";
      blockedAttempt.finishedAt = new Date().toISOString();
      run.status = "failed";
      run.error = `Approval rejected for ${node.id}`;
    }
    run.pendingApprovalIds = pending;
    const changed = await this.saveRun(run);
    return approved && !remainPaused ? this.run(changed.id) : changed;
  }

  async mutateGraph(runId: string, mutation: GraphMutation, expectedRevision?: number): Promise<WorkflowRun> {
    const run = this.requireRun(runId);
    return this.mutations.apply(runId, expectedRevision ?? run.graph.revision, mutation);
  }

  private async executeNode(run: WorkflowRun, sourceNode: GraphNode, workflow: WorkflowDefinition, context: ExecutionContext): Promise<WorkflowRun> {
    const next = structuredClone(run);
    const node = next.graph.nodes[sourceNode.id];
    if (!node) throw new Error(`Node not found: ${sourceNode.id}`);
    const attempt = this.startAttempt(next, node);
    await this.saveRun(next);
    try {
      await this.performNode(next, node, attempt, workflow, context);
    } catch (error) {
      this.failAttempt(next, node, attempt, error);
    }
    if (next.pendingApprovalIds.length) next.status = "blocked";
    return this.saveExecutionResult(next);
  }

  private async performNode(run: WorkflowRun, node: GraphNode, attempt: NodeAttempt, workflow: WorkflowDefinition, context: ExecutionContext): Promise<void> {
    const materialized = materializeNode(node, run.inputs, run);
    if (node.kind === "approval") {
      const approved = this.findApproved(run, node.id);
      if (!approved) {
        await this.blockForApproval(run, attempt, node, "Manual approval node");
        return;
      }
      attempt.approvedBy = approved.decidedBy;
      this.completeAttempt(run, node, attempt, "succeeded");
      return;
    }
    if (node.kind === "shell") {
      const details = commandDetails(materialized, this.options.cwd, materialized.env ?? {});
      const approved = Object.values(this.options.store.getSnapshot().approvals).find((approval) =>
        approval.runId === run.id && approval.nodeId === node.id && approval.digest === details.digest &&
        approval.status === "approved" && approval.graphRevision === run.graph.revision,
      );
      if (needsApproval(workflow.risk, materialized) && !approved) {
        await this.blockForApproval(run, attempt, node, `Approve command ${details.command}`, details);
        return;
      }
      attempt.approvedBy = approved?.decidedBy;
      const result = await this.options.shell.execute(materialized, context.cwd);
      attempt.command = result.command;
      attempt.cwd = result.cwd;
      attempt.exitCode = result.code;
      attempt.stdout = limit(result.stdout);
      attempt.stderr = limit(result.stderr);
      if (result.killed) attempt.error = "Command killed or timed out";
      else if (result.code !== 0) attempt.error = `Exit code ${result.code}`;
      this.completeAttempt(run, node, attempt, result.code === 0 && !result.killed ? "succeeded" : "failed");
      if (attempt.status === "succeeded") {
        const evidence = shellEvidence(run, node, attempt);
        await this.options.store.append("evidence.created", { evidenceId: evidence.id, evidence });
        attempt.evidenceIds.push(evidence.id);
      }
      return;
    }
    if (node.kind === "agent") {
      const child = await this.options.runtime.spawn({
        runId: run.id,
        nodeId: node.id,
        attempt,
        prompt: materialized.prompt ?? "",
        context,
        agentType: materialized.agent,
        mutateWorkflow: (mutation, expectedRevision) => this.mutateGraph(run.id, mutation, expectedRevision),
      });
      attempt.childSessionId = child.sessionId;
      attempt.output = limit(child.output);
      attempt.error = child.error;
      this.completeAttempt(run, node, attempt, child.status === "succeeded" ? "succeeded" : "failed");
      return;
    }
    if (node.kind === "condition") {
      this.completeAttempt(run, node, attempt, evaluate(materialized.condition ?? "", run.inputs, run) ? "succeeded" : "skipped");
      return;
    }
    if (node.kind === "parallel") {
      await this.executeParallel(run, node, attempt, workflow, context);
      return;
    }
    if (node.kind === "artifact" || node.kind === "receipt") {
      const value = materialized.path ?? materialized.url ?? materialized.content;
      if (!value) throw new Error(`${node.kind} node requires path, url, or content`);
      const evidence: Evidence = {
        id: stableId("evidence"),
        kind: node.kind,
        label: node.title,
        value,
        runId: run.id,
        nodeId: node.id,
        createdAt: new Date().toISOString(),
      };
      await this.options.store.append("evidence.created", { evidenceId: evidence.id, evidence });
      if (node.kind === "artifact") run.artifactIds.push(evidence.id);
      else run.receiptIds.push(evidence.id);
      attempt.evidenceIds.push(evidence.id);
      this.completeAttempt(run, node, attempt, "succeeded");
    }
  }

  private async executeParallel(run: WorkflowRun, node: GraphNode, attempt: NodeAttempt, workflow: WorkflowDefinition, context: ExecutionContext): Promise<void> {
    const branchIds = node.branches ?? [];
    const pending: Array<{ node: GraphNode; attempt: NodeAttempt }> = [];
    for (const branchId of branchIds) {
      const branch = run.graph.nodes[branchId];
      if (!branch) throw new Error(`Parallel branch not found: ${branchId}`);
      if (branch.status !== "pending") continue;
      const dependenciesReady = (branch.dependsOn ?? []).every((dependency) => {
        const status = run.graph.nodes[dependency]?.status;
        return status === "succeeded" || status === "skipped" || dependency === node.id;
      });
      if (!dependenciesReady) continue;
      pending.push({ node: branch, attempt: this.startAttempt(run, branch) });
    }
    if (pending.length) await this.saveRun(run);
    await Promise.all(pending.map(async ({ node: branch, attempt: branchAttempt }) => {
      try {
        await this.performNode(run, branch, branchAttempt, workflow, context);
      } catch (error) {
        this.failAttempt(run, branch, branchAttempt, error);
      }
    }));

    const statuses = branchIds.map((id) => run.graph.nodes[id]?.status ?? "failed");
    const joined = (node.join ?? "all") === "any"
      ? statuses.some((status) => status === "succeeded")
      : statuses.every((status) => status === "succeeded" || status === "skipped");
    attempt.output = JSON.stringify(Object.fromEntries(branchIds.map((id) => [id, run.graph.nodes[id]?.status ?? "missing"])));
    if (joined) this.completeAttempt(run, node, attempt, "succeeded");
    else if (statuses.some((status) => status === "blocked")) this.completeAttempt(run, node, attempt, "blocked");
    else this.completeAttempt(run, node, attempt, "failed");
  }

  private startAttempt(run: WorkflowRun, node: GraphNode): NodeAttempt {
    const attempt = makeAttempt(run.id, node.id, run.graph.revision);
    run.attempts[attempt.id] = attempt;
    node.status = "running";
    node.attempts.push(attempt.id);
    if (!run.graph.actualRoute.includes(node.id)) run.graph.actualRoute.push(node.id);
    return attempt;
  }

  private completeAttempt(run: WorkflowRun, node: GraphNode, attempt: NodeAttempt, status: NodeAttempt["status"]): void {
    attempt.status = status;
    attempt.finishedAt = new Date().toISOString();
    node.status = status;
  }

  private failAttempt(run: WorkflowRun, node: GraphNode, attempt: NodeAttempt, error: unknown): void {
    attempt.error = error instanceof Error ? error.message : String(error);
    this.completeAttempt(run, node, attempt, "failed");
    run.error = attempt.error;
  }

  private async blockForApproval(
    run: WorkflowRun,
    attempt: NodeAttempt,
    node: GraphNode,
    impact: string,
    details?: ReturnType<typeof commandDetails>,
  ): Promise<void> {
    const command = details?.command ?? node.title;
    const approval: Approval = {
      id: stableId("approval"),
      runId: run.id,
      nodeId: node.id,
      attemptId: attempt.id,
      command,
      cwd: details?.approval.cwd ?? this.options.cwd,
      environmentSummary: details?.approval.environmentSummary ?? "none",
      impact,
      rollback: details?.approval.rollback ?? "Stop and inspect before continuing",
      digest: details?.digest ?? `manual:${run.id}:${node.id}:${run.graph.revision}`,
      graphRevision: run.graph.revision,
      status: "pending",
    };
    this.completeAttempt(run, node, attempt, "blocked");
    run.pendingApprovalIds.push(approval.id);
    run.status = "blocked";
    await this.options.store.append("approval.created", { approvalId: approval.id, approval });
  }

  private findApproved(run: WorkflowRun, nodeId: string): Approval | undefined {
    return Object.values(this.options.store.getSnapshot().approvals).find((approval) =>
      approval.runId === run.id && approval.nodeId === nodeId && approval.graphRevision === run.graph.revision && approval.status === "approved",
    );
  }

  private async saveExecutionResult(run: WorkflowRun): Promise<WorkflowRun> {
    const latest = this.requireRun(run.id);
    const merged = structuredClone(latest);

    for (const [attemptId, attempt] of Object.entries(run.attempts)) merged.attempts[attemptId] = structuredClone(attempt);
    for (const [nodeId, localNode] of Object.entries(run.graph.nodes)) {
      const liveNode = merged.graph.nodes[nodeId];
      if (!liveNode) continue;
      liveNode.attempts = [...new Set([...liveNode.attempts, ...localNode.attempts])];
      const hasCompletedLocalAttempt = localNode.attempts.some((attemptId) => {
        const attempt = run.attempts[attemptId];
        return attempt && attempt.status !== "running";
      });
      if (hasCompletedLocalAttempt) liveNode.status = localNode.status;
    }
    merged.graph.actualRoute = [...new Set([...merged.graph.actualRoute, ...run.graph.actualRoute])];
    merged.pendingApprovalIds = [...new Set([...merged.pendingApprovalIds, ...run.pendingApprovalIds])];
    merged.artifactIds = [...new Set([...merged.artifactIds, ...run.artifactIds])];
    merged.receiptIds = [...new Set([...merged.receiptIds, ...run.receiptIds])];
    if (latest.status !== "paused" && latest.status !== "stopped") merged.status = run.status;
    merged.error = run.error ?? latest.error;
    return this.saveRun(merged);
  }

  private async saveRun(run: WorkflowRun): Promise<WorkflowRun> {
    run.updatedAt = new Date().toISOString();
    await this.options.store.append("run.updated", { run });
    return run;
  }

  private requireRun(id: string): WorkflowRun {
    const run = this.options.store.getSnapshot().runs[id];
    if (!run) throw new Error(`Run not found: ${id}`);
    return structuredClone(run);
  }
}

function shellEvidence(run: WorkflowRun, node: GraphNode, attempt: NodeAttempt): Evidence {
  const output = { command: attempt.command ?? "", cwd: attempt.cwd ?? run.id, exitCode: attempt.exitCode ?? null, stdout: attempt.stdout ?? "", stderr: attempt.stderr ?? "", verified: attempt.status === "succeeded" };
  const digest = createHash("sha256").update(JSON.stringify(output)).digest("hex");
  return { id: stableId("evidence"), kind: node.evidenceKind ?? (node.metadata?.evidenceKind as Evidence["kind"] | undefined) ?? "shell", label: node.title, value: JSON.stringify({ ...output, digest }), runId: run.id, nodeId: node.id, createdAt: new Date().toISOString() };
}

function limit(value: string, max = 20_000): string {
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
}

function interpolate(value: string, inputs: Record<string, string>, run: WorkflowRun): string {
  const withNodeOutputs = value.replace(/\{\{\s*nodes\.([\w-]+)\.output\s*\}\}/g, (_match, nodeId: string) => {
    const node = run.graph.nodes[nodeId];
    if (!node) return "";
    for (const attemptId of [...node.attempts].reverse()) {
      const attempt = run.attempts[attemptId];
      const output = attempt?.output ?? attempt?.stdout;
      if (output) return output;
    }
    return "";
  });
  return withNodeOutputs.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_match, key: string) => inputs[key] ?? "");
}

function materializeNode(node: GraphNode, inputs: Record<string, string>, run: WorkflowRun): WorkflowNode {
  return {
    ...node,
    prompt: node.prompt === undefined ? undefined : interpolate(node.prompt, inputs, run),
    command: node.command === undefined ? undefined : interpolate(node.command, inputs, run),
    args: node.args?.map((arg) => interpolate(arg, inputs, run)),
    cwd: node.cwd === undefined ? undefined : interpolate(node.cwd, inputs, run),
    env: node.env && Object.fromEntries(Object.entries(node.env).map(([key, value]) => [key, interpolate(value, inputs, run)])),
    condition: node.condition === undefined ? undefined : interpolate(node.condition, inputs, run),
    path: node.path === undefined ? undefined : interpolate(node.path, inputs, run),
    content: node.content === undefined ? undefined : interpolate(node.content, inputs, run),
    url: node.url === undefined ? undefined : interpolate(node.url, inputs, run),
  };
}

function evaluate(expression: string, inputs: Record<string, string>, run: WorkflowRun): boolean {
  const match = expression.match(/^([\w-]+)\s*(==|!=|exists)\s*(?:"([^"]*)"|'([^']*)')?$/);
  if (!match) return false;
  const key = match[1] ?? "";
  const value = inputs[key] ?? run.graph.nodes[key]?.status ?? "";
  if (match[2] === "exists") return Boolean(value);
  const expected = match[3] ?? match[4] ?? "";
  return match[2] === "==" ? value === expected : value !== expected;
}
