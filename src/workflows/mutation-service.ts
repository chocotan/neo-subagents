import type { GraphMutation, RiskLevel, WorkflowNode, WorkflowRun } from "../domain/types.js";
import type { NeoStateStore } from "../state/store.js";
import { MutableGraph } from "./graph.js";
import { WorkflowValidationError } from "./workflow-loader.js";

export class WorkflowMutationService {
  constructor(private readonly store: NeoStateStore) {}

  async apply(runId: string, expectedRevision: number, mutation: GraphMutation): Promise<WorkflowRun> {
    const run = this.store.getSnapshot().runs[runId];
    if (!run) throw new WorkflowValidationError(`Run not found: ${runId}`);
    if (run.graph.revision !== expectedRevision) {
      throw new WorkflowValidationError(`Stale graph revision: expected ${expectedRevision}, current ${run.graph.revision}`);
    }
    if (["succeeded", "stopped"].includes(run.status)) throw new WorkflowValidationError(`Cannot mutate ${run.status} run: ${runId}`);

    const changed = structuredClone(run);
    const graph = new MutableGraph(changed.graph);
    switch (mutation.type) {
      case "add":
        validateMutationNode(mutation.node);
        graph.add(mutation.node, mutation.reason);
        break;
      case "skip":
        graph.skip(mutation.nodeId, mutation.reason);
        break;
      case "reorder":
        graph.reorder(mutation.order, mutation.reason);
        break;
      case "split":
        for (const node of mutation.nodes) validateMutationNode(node);
        graph.split(mutation.nodeId, mutation.nodes, mutation.reason);
        break;
      case "merge":
        validateMutationNode(mutation.node);
        graph.merge(mutation.nodeIds, mutation.node, mutation.reason);
        break;
    }
    changed.graph = graph.value;
    changed.updatedAt = new Date().toISOString();

    await this.store.append("graph.mutated", {
      run: changed,
      runId,
      previousRevision: expectedRevision,
      graphRevision: changed.graph.revision,
      mutation,
    });
    return changed;
  }
}

const kinds = new Set<WorkflowNode["kind"]>(["agent", "shell", "approval", "condition", "parallel", "artifact", "receipt"]);
const risks = new Set<RiskLevel>(["low", "medium", "high", "critical"]);

function validateMutationNode(node: WorkflowNode): void {
  if (!node.id || !node.title) throw new WorkflowValidationError("Mutation node requires id and title");
  if (!kinds.has(node.kind)) throw new WorkflowValidationError(`Unknown node kind: ${node.kind}`);
  if (node.risk && !risks.has(node.risk)) throw new WorkflowValidationError(`Invalid risk on ${node.id}`);
  if (node.kind === "shell" && !node.command) throw new WorkflowValidationError(`Shell node ${node.id} requires command`);
  if (node.kind === "agent" && !node.prompt) throw new WorkflowValidationError(`Agent node ${node.id} requires prompt`);
  if (node.kind === "approval" && node.approval === false) throw new WorkflowValidationError(`Approval node ${node.id} cannot disable approval`);
  if (node.kind === "parallel") {
    if (!node.branches?.length) throw new WorkflowValidationError(`Parallel node ${node.id} requires branches`);
    if (node.join && !["all", "any"].includes(node.join)) throw new WorkflowValidationError(`Invalid parallel join on ${node.id}`);
  }
}
