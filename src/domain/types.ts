export type RiskLevel = "low" | "medium" | "high" | "critical";
export type NodeKind = "agent" | "shell" | "approval" | "condition" | "parallel" | "artifact" | "receipt";
export type NodeStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "skipped" | "unknown_effect";
export type RunStatus = "pending" | "running" | "paused" | "failed" | "blocked" | "succeeded" | "stopped";
export type TodoStatus = "pending" | "in_progress" | "done" | "skipped" | "blocked" | "failed";

export interface WorkflowInput {
  name: string;
  required?: boolean;
  default?: string;
}

export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  title: string;
  dependsOn?: string[];
  risk?: RiskLevel;
  approval?: boolean;
  agent?: string;
  prompt?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  condition?: string;
  branches?: string[];
  join?: "all" | "any";
  path?: string;
  content?: string;
  url?: string;
  evidenceKind?: "shell" | "test" | "health";
  metadata?: Record<string, string>;
}

export interface WorkflowDefinition {
  name: string;
  version: number;
  description: string;
  risk: RiskLevel;
  inputs: WorkflowInput[];
  recommendedSkills: string[];
  discoverScopes: string[];
  nodes: WorkflowNode[];
  successCriteria: string[];
  sourcePath: string;
  sourceDigest: string;
}

export interface GraphNode extends WorkflowNode {
  status: NodeStatus;
  attempts: string[];
  skipReason?: string;
}

export interface GraphState {
  revision: number;
  nodes: Record<string, GraphNode>;
  plannedRoute: string[];
  actualRoute: string[];
}

export type GraphMutation =
  | { type: "add"; node: WorkflowNode; reason: string }
  | { type: "skip"; nodeId: string; reason: string }
  | { type: "reorder"; order: string[]; reason: string }
  | { type: "split"; nodeId: string; nodes: WorkflowNode[]; reason: string }
  | { type: "merge"; nodeIds: string[]; node: WorkflowNode; reason: string };

export interface NodeAttempt {
  id: string;
  runId: string;
  nodeId: string;
  status: NodeStatus;
  startedAt: string;
  finishedAt?: string;
  childSessionId?: string;
  output?: string;
  error?: string;
  command?: string;
  cwd?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  approvedBy?: string;
  graphRevision: number;
  evidenceIds: string[];
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  workflowVersion: number;
  goalId?: string;
  status: RunStatus;
  inputs: Record<string, string>;
  graph: GraphState;
  attempts: Record<string, NodeAttempt>;
  pendingApprovalIds: string[];
  artifactIds: string[];
  receiptIds: string[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: "open" | "paused" | "closed";
  runIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Todo {
  id: string;
  title: string;
  status: TodoStatus;
  runId?: string;
  nodeId?: string;
  manual: boolean;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Approval {
  id: string;
  runId: string;
  nodeId: string;
  attemptId: string;
  command: string;
  cwd: string;
  environmentSummary: string;
  impact: string;
  rollback: string;
  digest: string;
  graphRevision: number;
  status: "pending" | "approved" | "rejected";
  decidedBy?: string;
  decidedAt?: string;
}

export interface Evidence {
  id: string;
  kind: "artifact" | "receipt" | "shell" | "test" | "health";
  label: string;
  value: string;
  runId: string;
  nodeId: string;
  createdAt: string;
}

export interface Profile {
  name: string;
  description: string;
  focus: string[];
  recommendedSkills: string[];
  discoverScopes: string[];
  useParentSkills?: "*";
  recommendedAgents: string[];
  communicationStyle?: string;
  memoryScope?: string;
  recommendedWorkflows: string[];
  sourcePath: string;
}

export interface NeoEvent {
  id: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface NeoSnapshot {
  schemaVersion: 1;
  revision: number;
  activeProfile?: string;
  goals: Record<string, Goal>;
  todos: Record<string, Todo>;
  runs: Record<string, WorkflowRun>;
  approvals: Record<string, Approval>;
  evidence: Record<string, Evidence>;
  events: NeoEvent[];
}

export interface SkillResult {
  name: string;
  status: "loaded" | "missing" | "unreadable" | "invalid";
  source?: string;
  content?: string;
  reason?: string;
}

export interface ExecutionContext {
  cwd: string;
  profile?: Profile;
  workflowName?: string;
  skills: SkillResult[];
  discoverScopes?: string[];
  useParentSkills?: "*";
  inheritedSkillCount?: number;
  temporary: boolean;
}
