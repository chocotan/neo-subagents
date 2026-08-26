import type { GraphNode, GraphState, WorkflowDefinition, WorkflowNode } from "../domain/types.js";
import { WorkflowValidationError } from "./workflow-loader.js";

export function createGraph(workflow: WorkflowDefinition): GraphState {
  const nodes: Record<string, GraphNode> = {};
  for (const node of workflow.nodes) nodes[node.id] = { ...node, status: "pending", attempts: [] };
  return { revision: 1, nodes, plannedRoute: workflow.nodes.map((node) => node.id), actualRoute: [] };
}

export class MutableGraph {
  constructor(private state: GraphState) {}

  get value(): GraphState { return structuredClone(this.state); }

  ready(): GraphNode[] {
    const ownedBranches = new Set(Object.values(this.state.nodes).flatMap((node) => node.kind === "parallel" ? node.branches ?? [] : []));
    return Object.values(this.state.nodes).filter((node) => !ownedBranches.has(node.id) && node.status === "pending" && (node.dependsOn ?? []).every((id) => ["succeeded", "skipped"].includes(this.state.nodes[id]?.status ?? "pending")));
  }

  add(node: WorkflowNode, reason: string): void {
    if (this.state.nodes[node.id]) throw new WorkflowValidationError(`Node already exists: ${node.id}`);
    this.state.nodes[node.id] = this.newNode(node, reason);
    this.state.plannedRoute.push(node.id);
    this.validate();
    this.bump();
  }

  skip(id: string, reason: string): void {
    const node = this.require(id);
    if (node.status === "running" || node.status === "succeeded") throw new WorkflowValidationError(`Cannot skip ${node.status} node: ${id}`);
    node.status = "skipped";
    node.skipReason = reason;
    this.bump();
  }

  reorder(order: readonly string[], reason: string): void {
    if (new Set(order).size !== Object.keys(this.state.nodes).length || order.some((id) => !this.state.nodes[id])) throw new WorkflowValidationError("Reorder must contain every node exactly once");
    this.assertRouteDependencies(order);
    this.state.plannedRoute = [...order];
    const first = this.state.nodes[order[0] ?? ""];
    if (first) first.metadata = { ...(first.metadata ?? {}), reorderReason: reason };
    this.bump();
  }

  split(id: string, replacements: readonly WorkflowNode[], reason: string): void {
    const source = this.requirePending(id, "split");
    if (replacements.length < 2) throw new WorkflowValidationError("Split requires at least two replacement nodes");
    this.assertNewIds(replacements.map((node) => node.id), new Set([id]));

    const replacementIds = replacements.map((node) => node.id);
    const originalDependencies = source.dependsOn ?? [];
    delete this.state.nodes[id];

    replacements.forEach((node, index) => {
      const inherited = index === 0 ? originalDependencies : [replacementIds[index - 1] as string];
      const explicit = (node.dependsOn ?? []).filter((dependency) => dependency !== id);
      this.state.nodes[node.id] = this.newNode({ ...node, dependsOn: unique([...inherited, ...explicit]) }, reason);
    });

    const finalId = replacementIds[replacementIds.length - 1] as string;
    for (const node of Object.values(this.state.nodes)) node.dependsOn = replaceDependencies(node.dependsOn, new Set([id]), finalId);
    this.replaceParallelBranches(new Set([id]), replacementIds[0] as string);
    this.state.plannedRoute = replaceRoute(this.state.plannedRoute, new Set([id]), replacementIds);
    this.validate();
    this.state.plannedRoute = stableTopologicalRoute(this.state);
    this.bump();
  }

  merge(ids: readonly string[], replacement: WorkflowNode, reason: string): void {
    if (ids.length < 2) throw new WorkflowValidationError("Merge requires at least two source nodes");
    if (new Set(ids).size !== ids.length) throw new WorkflowValidationError("Merge source node ids must be unique");
    const sourceIds = new Set(ids);
    const sources = ids.map((id) => this.requirePending(id, "merge"));
    this.assertNewIds([replacement.id], sourceIds);

    const externalDependencies = unique(sources.flatMap((node) => node.dependsOn ?? []).filter((dependency) => !sourceIds.has(dependency)));
    const explicitDependencies = (replacement.dependsOn ?? []).filter((dependency) => !sourceIds.has(dependency));
    for (const id of ids) delete this.state.nodes[id];
    this.state.nodes[replacement.id] = this.newNode({ ...replacement, dependsOn: unique([...externalDependencies, ...explicitDependencies]) }, reason);

    for (const node of Object.values(this.state.nodes)) {
      if (node.id !== replacement.id) node.dependsOn = replaceDependencies(node.dependsOn, sourceIds, replacement.id);
    }
    this.replaceParallelBranches(sourceIds, replacement.id);
    this.state.plannedRoute = replaceRoute(this.state.plannedRoute, sourceIds, [replacement.id]);
    this.validate();
    this.state.plannedRoute = stableTopologicalRoute(this.state);
    this.bump();
  }

  setStatus(id: string, status: GraphNode["status"]): void {
    const node = this.require(id);
    node.status = status;
    if (!this.state.actualRoute.includes(id)) this.state.actualRoute.push(id);
    this.bump();
  }

  private newNode(node: WorkflowNode, reason: string): GraphNode {
    return { ...node, status: "pending", attempts: [], metadata: { ...(node.metadata ?? {}), mutationReason: reason } };
  }

  private require(id: string): GraphNode {
    const node = this.state.nodes[id];
    if (!node) throw new WorkflowValidationError(`Unknown node: ${id}`);
    return node;
  }

  private requirePending(id: string, operation: string): GraphNode {
    const node = this.require(id);
    if (node.status !== "pending") throw new WorkflowValidationError(`Cannot ${operation} ${node.status} node: ${id}`);
    return node;
  }

  private assertNewIds(ids: readonly string[], removedIds: ReadonlySet<string>): void {
    const seen = new Set<string>();
    for (const id of ids) {
      if (!id || seen.has(id)) throw new WorkflowValidationError(`Duplicate or empty replacement node id: ${id}`);
      seen.add(id);
      if (this.state.nodes[id] && !removedIds.has(id)) throw new WorkflowValidationError(`Node already exists: ${id}`);
      if (removedIds.has(id)) throw new WorkflowValidationError(`Replacement node id must be new: ${id}`);
    }
  }

  private replaceParallelBranches(sourceIds: ReadonlySet<string>, replacementId: string): void {
    for (const node of Object.values(this.state.nodes)) {
      if (node.kind !== "parallel" || !node.branches?.some((id) => sourceIds.has(id))) continue;
      node.branches = unique(node.branches.map((id) => sourceIds.has(id) ? replacementId : id));
    }
  }

  private validate(): void {
    const branchOwners = new Map<string, string>();
    for (const node of Object.values(this.state.nodes)) {
      const dependencies = node.dependsOn ?? [];
      if (new Set(dependencies).size !== dependencies.length) throw new WorkflowValidationError(`Duplicate dependency on ${node.id}`);
      for (const dependency of dependencies) {
        if (!this.state.nodes[dependency]) throw new WorkflowValidationError(`${node.id} depends on missing node ${dependency}`);
        if (dependency === node.id) throw new WorkflowValidationError(`Workflow graph cycle at ${node.id}`);
      }
      if (node.kind === "parallel") {
        for (const branchId of node.branches ?? []) {
          if (!this.state.nodes[branchId]) throw new WorkflowValidationError(`${node.id} references missing parallel branch ${branchId}`);
          if (branchId === node.id) throw new WorkflowValidationError(`Parallel node ${node.id} cannot branch to itself`);
          const owner = branchOwners.get(branchId);
          if (owner && owner !== node.id) throw new WorkflowValidationError(`Parallel branch ${branchId} is already owned by ${owner}`);
          branchOwners.set(branchId, node.id);
        }
      }
    }
    stableTopologicalRoute(this.state);
  }

  private assertRouteDependencies(order: readonly string[]): void {
    const position = new Map(order.map((id, index) => [id, index]));
    for (const node of Object.values(this.state.nodes)) {
      for (const dependency of node.dependsOn ?? []) {
        if ((position.get(dependency) ?? -1) > (position.get(node.id) ?? -1)) throw new WorkflowValidationError(`Reorder places ${node.id} before dependency ${dependency}`);
      }
    }
  }

  private bump(): void { this.state.revision += 1; }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function replaceDependencies(dependencies: readonly string[] | undefined, sourceIds: ReadonlySet<string>, replacementId: string): string[] | undefined {
  if (!dependencies?.some((dependency) => sourceIds.has(dependency))) return dependencies ? [...dependencies] : undefined;
  return unique(dependencies.map((dependency) => sourceIds.has(dependency) ? replacementId : dependency));
}

function replaceRoute(route: readonly string[], sourceIds: ReadonlySet<string>, replacements: readonly string[]): string[] {
  const result: string[] = [];
  let inserted = false;
  for (const id of route) {
    if (!sourceIds.has(id)) result.push(id);
    else if (!inserted) {
      result.push(...replacements);
      inserted = true;
    }
  }
  if (!inserted) result.push(...replacements);
  return result;
}

function stableTopologicalRoute(state: GraphState): string[] {
  const priority = new Map(state.plannedRoute.map((id, index) => [id, index]));
  const remaining = new Set(Object.keys(state.nodes));
  const result: string[] = [];
  while (remaining.size) {
    const next = [...remaining]
      .filter((id) => (state.nodes[id]?.dependsOn ?? []).every((dependency) => !remaining.has(dependency)))
      .sort((left, right) => (priority.get(left) ?? Number.MAX_SAFE_INTEGER) - (priority.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right))[0];
    if (!next) throw new WorkflowValidationError(`Workflow graph cycle at ${[...remaining][0]}`);
    result.push(next);
    remaining.delete(next);
  }
  return result;
}
