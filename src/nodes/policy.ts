import { createHash } from "node:crypto";
import type { Approval, NodeAttempt, RiskLevel, WorkflowNode } from "../domain/types.js";
import { stableId } from "../state/store.js";

const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export function maxRisk(...risks: RiskLevel[]): RiskLevel { return risks.reduce((max, risk) => rank[risk] > rank[max] ? risk : max, "low"); }
export function needsApproval(workflowRisk: RiskLevel, node: WorkflowNode): boolean { return Boolean(node.approval) || rank[maxRisk(workflowRisk, node.risk ?? "low")] >= rank.high; }
export function commandDetails(node: WorkflowNode, cwd: string, environment: Record<string, string>): { command: string; digest: string; approval: Omit<Approval, "id" | "attemptId" | "status" | "decidedBy" | "decidedAt"> } {
  const command = [node.command ?? "", ...(node.args ?? [])].join(" ");
  const effectiveCwd = node.cwd ? (node.cwd.startsWith("/") ? node.cwd : `${cwd}/${node.cwd}`) : cwd;
  const environmentSummary = Object.keys(environment).sort().map((key) => `${key}=<set>`).join(", ");
  const digest = createHash("sha256").update(JSON.stringify({ command, cwd: effectiveCwd, environment })).digest("hex");
  return { command, digest, approval: { runId: "", nodeId: node.id, command, cwd: effectiveCwd, environmentSummary, impact: node.metadata?.impact ?? "External command execution", rollback: node.metadata?.rollback ?? "No rollback declared", digest, graphRevision: 0 } };
}
export function makeAttempt(runId: string, nodeId: string, graphRevision: number): NodeAttempt { return { id: stableId("attempt"), runId, nodeId, status: "running", startedAt: new Date().toISOString(), graphRevision, evidenceIds: [] }; }
