import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { RiskLevel, WorkflowDefinition, WorkflowInput, WorkflowNode } from "../domain/types.js";

const risks = new Set<RiskLevel>(["low", "medium", "high", "critical"]);
const kinds = new Set<WorkflowNode["kind"]>(["agent", "shell", "approval", "condition", "parallel", "artifact", "receipt"]);

export class WorkflowValidationError extends Error {}
export function validateWorkflow(workflow: WorkflowDefinition): void {
  if (!workflow.name || !Number.isInteger(workflow.version) || workflow.version < 1) throw new WorkflowValidationError("Workflow name and positive integer version are required");
  if (!risks.has(workflow.risk)) throw new WorkflowValidationError(`Invalid workflow risk: ${workflow.risk}`);
  const ids = new Set<string>();
  const branchOwners = new Map<string, string>();
  for (const node of workflow.nodes) {
    if (!node.id || ids.has(node.id)) throw new WorkflowValidationError(`Duplicate or empty node id: ${node.id}`);
    ids.add(node.id);
    if (!kinds.has(node.kind)) throw new WorkflowValidationError(`Unknown node kind: ${node.kind}`);
    if (node.risk && !risks.has(node.risk)) throw new WorkflowValidationError(`Invalid risk on ${node.id}`);
    if (node.kind === "shell" && !node.command) throw new WorkflowValidationError(`Shell node ${node.id} requires command`);
    if (node.kind === "agent" && !node.prompt) throw new WorkflowValidationError(`Agent node ${node.id} requires prompt`);
    if (node.kind === "approval" && node.approval === false) throw new WorkflowValidationError(`Approval node ${node.id} cannot disable approval`);
    if (node.kind === "parallel") {
      if (!node.branches?.length) throw new WorkflowValidationError(`Parallel node ${node.id} requires branches`);
      if (node.join && !["all", "any"].includes(node.join)) throw new WorkflowValidationError(`Invalid parallel join on ${node.id}`);
      for (const branchId of node.branches) {
        if (branchId === node.id) throw new WorkflowValidationError(`Parallel node ${node.id} cannot branch to itself`);
        const owner = branchOwners.get(branchId);
        if (owner) throw new WorkflowValidationError(`Parallel branch ${branchId} is already owned by ${owner}`);
        branchOwners.set(branchId, node.id);
      }
    }
    for (const dependency of node.dependsOn ?? []) if (!workflow.nodes.some((candidate) => candidate.id === dependency)) throw new WorkflowValidationError(`${node.id} depends on missing node ${dependency}`);
  }
  for (const [branchId, owner] of branchOwners) {
    if (!ids.has(branchId)) throw new WorkflowValidationError(`${owner} references missing parallel branch ${branchId}`);
  }
  detectCycle(workflow.nodes);
}
function detectCycle(nodes: readonly WorkflowNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => { if (visiting.has(id)) throw new WorkflowValidationError(`Workflow graph cycle at ${id}`); if (visited.has(id)) return; visiting.add(id); for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep); visiting.delete(id); visited.add(id); };
  for (const node of nodes) visit(node.id);
}

interface RawWorkflow { name?: string; version?: number; description?: string; risk?: RiskLevel; inputs?: WorkflowInput[]; recommendedSkills?: string[]; discoverScopes?: string[]; nodes?: WorkflowNode[] | Record<string, Omit<WorkflowNode, "id">>; successCriteria?: string[]; }
export class WorkflowLoader {
  constructor(private readonly cwd: string) {}
  async list(): Promise<WorkflowDefinition[]> {
    const byName = new Map<string, WorkflowDefinition>();
    for (const file of await this.files()) {
      try {
        const workflow = await this.load(file);
        if (!byName.has(workflow.name)) byName.set(workflow.name, workflow);
      } catch { /* list remains usable when one file is invalid */ }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async get(name: string): Promise<WorkflowDefinition | undefined> { return (await this.list()).find((workflow) => workflow.name === name); }
  async load(file: string): Promise<WorkflowDefinition> {
    const source = await readFile(file, "utf8"); const raw = YAML.parse(source) as RawWorkflow;
    const nodes = Array.isArray(raw.nodes) ? raw.nodes : Object.entries(raw.nodes ?? {}).map(([id, node]) => ({ ...node, id }));
    const workflow: WorkflowDefinition = { name: raw.name ?? "", version: raw.version ?? 0, description: raw.description ?? "", risk: raw.risk ?? "low", inputs: raw.inputs ?? [], recommendedSkills: raw.recommendedSkills ?? [], discoverScopes: raw.discoverScopes ?? [], nodes, successCriteria: raw.successCriteria ?? [], sourcePath: resolve(file), sourceDigest: createHash("sha256").update(source).digest("hex") };
    validateWorkflow(workflow); return workflow;
  }
  private async files(): Promise<string[]> {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const roots = [
      join(this.cwd, ".pi", "workflows"),
      join(homedir(), ".pi", "agent", "workflows"),
      join(packageRoot, "assets", "workflows"),
    ];
    const files: string[] = [];
    for (const root of roots) {
      try {
        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (entry.isFile() && /\.(yaml|yml)$/i.test(entry.name)) files.push(resolve(root, entry.name));
        }
      } catch { /* optional */ }
    }
    return files;
  }
}
