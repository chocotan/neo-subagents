import { describe, expect, it } from "vitest";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { emptySnapshot } from "../../src/domain/reducer.js";
import type { Goal, NeoSnapshot, Todo, WorkflowRun } from "../../src/domain/types.js";
import type { ChildSessionRecord, ChildStatus } from "../../src/runtime/native-runtime.js";
import {
  NeoStatusController,
  NeoStatusWidget,
  createNeoUiModel,
} from "../../src/ui/neo-status.js";

const NOW = "2026-01-01T00:00:00.000Z";
const theme = {
  fg: (_color: string, text: string) => text,
} as Theme;

function todo(id: string, status: Todo["status"], title = id): Todo {
  return { id, title, status, manual: true, evidenceIds: [], createdAt: NOW, updatedAt: NOW };
}

function goal(id: string, status: Goal["status"], title = id): Goal {
  return { id, title, description: title, status, runIds: [], createdAt: NOW, updatedAt: NOW };
}

function run(id: string, status: WorkflowRun["status"], workflowName = id): WorkflowRun {
  return {
    id,
    workflowName,
    workflowVersion: 1,
    status,
    inputs: {},
    graph: { revision: 1, nodes: {}, plannedRoute: [], actualRoute: [] },
    attempts: {},
    pendingApprovalIds: [],
    artifactIds: [],
    receiptIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function child(id: string, status: ChildStatus): ChildSessionRecord {
  return {
    id,
    runId: `run-${id}`,
    nodeId: `node-${id}`,
    attemptId: `attempt-${id}`,
    sessionId: `session-${id}`,
    cwd: "/tmp",
    status,
    output: "",
    events: [],
    turnCount: 0,
  };
}

function populatedSnapshot(): NeoSnapshot {
  const snapshot = emptySnapshot();
  snapshot.revision = 1;
  snapshot.todos = {
    done: todo("done", "done"),
    pending: todo("pending", "pending"),
    active: todo("active", "in_progress"),
    blocked: todo("blocked", "blocked"),
    failed: todo("failed", "failed"),
  };
  snapshot.runs = {
    release: run("release", "running", "release"),
    complete: run("complete", "succeeded", "complete"),
  };
  snapshot.goals = {
    open: goal("open", "open", "Ship release"),
    closed: goal("closed", "closed", "Old goal"),
  };
  return snapshot;
}

describe("Neo status rendering", () => {
  it("prioritizes actionable state and excludes terminal items", () => {
    const model = createNeoUiModel(populatedSnapshot(), [
      child("running", "running"),
      child("queued", "queued"),
      child("succeeded", "succeeded"),
    ]);

    expect(model.status).toBe("Neo · 1/5 todo · release running · 2 child");
    expect(model.entries).toHaveLength(6);
    expect(model.entries.slice(0, 3).map((entry) => `${entry.kind}:${entry.status}`)).toEqual([
      "Todo:failed",
      "Todo:blocked",
      "Todo:in_progress",
    ]);
    expect(model.entries.map((entry) => entry.kind)).toEqual([
      "Todo",
      "Todo",
      "Todo",
      "Workflow",
      "Goal",
      "Child",
    ]);
    expect(model.entries.some((entry) => entry.title.includes("complete"))).toBe(false);
    expect(model.entries.some((entry) => entry.title.includes("succeeded"))).toBe(false);
  });

  it("keeps every rendered line within narrow terminal widths", () => {
    const model = createNeoUiModel(populatedSnapshot(), [child("running-with-a-long-id", "running")]);
    const widget = new NeoStatusWidget(() => model.entries, theme);

    for (const width of [1, 4, 12, 24]) {
      const lines = widget.render(width);
      expect(lines.length).toBeLessThanOrEqual(6);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });
});

describe("Neo status controller", () => {
  it("does not request another render for the same visible render key", () => {
    let snapshot = populatedSnapshot();
    const children = [child("running", "running")];
    let factory: ((tui: TUI, theme: Theme) => Component) | undefined;
    const statuses: Array<string | undefined> = [];
    const context = {
      hasUI: true,
      mode: "tui",
      ui: {
        setStatus: (_key: string, value: string | undefined) => statuses.push(value),
        setWidget: (_key: string, value: unknown) => {
          if (typeof value === "function") factory = value as typeof factory;
        },
      },
    } as unknown as ExtensionContext;
    const controller = new NeoStatusController();
    controller.start(context, {
      store: { getSnapshot: () => structuredClone(snapshot) },
      runtime: { status: () => structuredClone(children) },
    });

    let renderRequests = 0;
    const tui = { requestRender: () => { renderRequests += 1; } } as unknown as TUI;
    const widget = factory?.(tui, theme);
    expect(widget).toBeDefined();
    widget?.render(80);

    expect(controller.refresh()).toBe(false);
    expect(renderRequests).toBe(0);

    snapshot = { ...snapshot, revision: snapshot.revision + 1 };
    expect(controller.refresh()).toBe(false);
    expect(renderRequests).toBe(0);

    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      todos: { ...snapshot.todos, newTodo: todo("newTodo", "failed", "New failure") },
    };
    expect(controller.refresh()).toBe(true);
    expect(renderRequests).toBe(1);
    expect(controller.refresh()).toBe(false);
    expect(renderRequests).toBe(1);
    expect(statuses.at(-1)).toContain("1/6 todo");

    controller.stop();
  });
});
