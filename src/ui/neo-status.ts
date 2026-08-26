import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { NeoSnapshot, RunStatus, TodoStatus } from "../domain/types.js";
import type { ChildSessionRecord, ChildStatus } from "../runtime/native-runtime.js";

export const NEO_WIDGET_KEY = "neo";
export const NEO_STATUS_KEY = "neo-status";
export const NEO_STATUS_INTERVAL_MS = 500;
export const NEO_WIDGET_MAX_LINES = 6;

interface NeoUiSource {
  store: { getSnapshot(): NeoSnapshot };
  runtime: { status(): ChildSessionRecord[] };
}

type EntryKind = "Todo" | "Workflow" | "Goal" | "Child";
type EntryTone = Extract<ThemeColor, "accent" | "dim" | "error" | "warning">;

export interface NeoWidgetEntry {
  kind: EntryKind;
  status: string;
  title: string;
  tone: EntryTone;
  priority: number;
}

export interface NeoUiModel {
  status: string;
  entries: NeoWidgetEntry[];
}

interface WidgetBinding {
  tui: TUI;
  widget: NeoStatusWidget;
}

const TODO_PRIORITY: Record<TodoStatus, number> = {
  failed: 0,
  blocked: 1,
  in_progress: 2,
  pending: 3,
  done: 100,
  skipped: 101,
};
const RUN_PRIORITY: Record<RunStatus, number> = {
  failed: 0,
  blocked: 1,
  running: 2,
  paused: 3,
  pending: 4,
  succeeded: 100,
  stopped: 101,
};
const CHILD_PRIORITY: Record<ChildStatus, number> = {
  failed: 0,
  running: 1,
  queued: 2,
  stopped: 100,
  succeeded: 101,
};

export function createNeoUiModel(snapshot: NeoSnapshot, children: readonly ChildSessionRecord[]): NeoUiModel {
  const todos = Object.values(snapshot.todos);
  const doneTodos = todos.filter((todo) => todo.status === "done").length;
  const activeRuns = Object.values(snapshot.runs)
    .filter((run) => run.status !== "succeeded" && run.status !== "stopped")
    .sort((left, right) => RUN_PRIORITY[left.status] - RUN_PRIORITY[right.status]
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.id.localeCompare(right.id));
  const activeChildren = children.filter((child) => child.status === "queued" || child.status === "running");
  const failedChildren = children.filter((child) => child.status === "failed");

  const statusParts = [`Neo · ${doneTodos}/${todos.length} todo`];
  const primaryRun = activeRuns[0];
  if (primaryRun) statusParts.push(`${primaryRun.workflowName} ${primaryRun.status}`);
  if (activeChildren.length > 0) statusParts.push(`${activeChildren.length} child`);
  else if (failedChildren.length > 0) statusParts.push(`${failedChildren.length} child failed`);

  const todoEntries = todos
    .filter((todo) => todo.status !== "done" && todo.status !== "skipped")
    .sort((left, right) => TODO_PRIORITY[left.status] - TODO_PRIORITY[right.status]
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.id.localeCompare(right.id))
    .map((todo): NeoWidgetEntry => ({
      kind: "Todo",
      status: todo.status,
      title: todo.title,
      tone: toneForStatus(todo.status),
      priority: TODO_PRIORITY[todo.status],
    }));
  const workflowEntries = activeRuns.map((run): NeoWidgetEntry => {
    const nodes = Object.values(run.graph.nodes);
    const succeeded = nodes.filter((node) => node.status === "succeeded").length;
    return {
      kind: "Workflow",
      status: run.status,
      title: `${run.workflowName} · ${succeeded}/${nodes.length} nodes`,
      tone: toneForStatus(run.status),
      priority: 10 + RUN_PRIORITY[run.status],
    };
  });
  const goalEntries = Object.values(snapshot.goals)
    .filter((goal) => goal.status !== "closed")
    .sort((left, right) => Number(left.status === "paused") - Number(right.status === "paused")
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.id.localeCompare(right.id))
    .map((goal): NeoWidgetEntry => ({
      kind: "Goal",
      status: goal.status,
      title: goal.title,
      tone: goal.status === "paused" ? "warning" : "accent",
      priority: goal.status === "paused" ? 31 : 30,
    }));
  const childEntries = children
    .filter((child) => child.status !== "succeeded" && child.status !== "stopped")
    .sort((left, right) => CHILD_PRIORITY[left.status] - CHILD_PRIORITY[right.status]
      || left.id.localeCompare(right.id))
    .map((child): NeoWidgetEntry => ({
      kind: "Child",
      status: child.status,
      title: `${child.nodeId} · ${child.agentType ?? "anonymous"} · ${child.id}`,
      tone: toneForStatus(child.status),
      priority: 20 + CHILD_PRIORITY[child.status],
    }));

  return {
    status: statusParts.join(" · "),
    entries: selectWidgetEntries(todoEntries, workflowEntries, goalEntries, childEntries),
  };
}

function selectWidgetEntries(
  todos: NeoWidgetEntry[],
  workflows: NeoWidgetEntry[],
  goals: NeoWidgetEntry[],
  children: NeoWidgetEntry[],
): NeoWidgetEntry[] {
  const selected = [
    ...todos.slice(0, 3),
    ...workflows.slice(0, 1),
    ...goals.slice(0, 1),
    ...children.slice(0, 1),
  ].slice(0, NEO_WIDGET_MAX_LINES);
  if (selected.length === NEO_WIDGET_MAX_LINES) return selected;

  const remaining = [
    ...todos.slice(3),
    ...workflows.slice(1),
    ...children.slice(1),
    ...goals.slice(1),
  ].sort((left, right) => left.priority - right.priority || left.title.localeCompare(right.title));
  return [...selected, ...remaining.slice(0, NEO_WIDGET_MAX_LINES - selected.length)];
}

function toneForStatus(status: TodoStatus | RunStatus | ChildStatus): EntryTone {
  if (status === "failed") return "error";
  if (status === "blocked" || status === "paused") return "warning";
  if (status === "running" || status === "in_progress") return "accent";
  return "dim";
}

export class NeoStatusWidget extends Container {
  private dirty = true;
  private width?: number;

  constructor(
    private readonly getEntries: () => readonly NeoWidgetEntry[],
    private readonly theme: Theme,
    private readonly onDispose?: () => void,
  ) {
    super();
  }

  override render(width: number): string[] {
    const availableWidth = Math.max(0, Math.floor(width));
    if (availableWidth === 0) return [];
    if (this.dirty || this.width !== availableWidth) this.rebuild(availableWidth);
    return super.render(availableWidth)
      .slice(0, NEO_WIDGET_MAX_LINES)
      .map((line) => truncateToWidth(line, availableWidth));
  }

  override invalidate(): void {
    this.dirty = true;
    super.invalidate();
  }

  dispose(): void {
    this.onDispose?.();
  }

  private rebuild(width: number): void {
    this.clear();
    for (const entry of this.getEntries().slice(0, NEO_WIDGET_MAX_LINES)) {
      const text = this.theme.fg("muted", entry.kind)
        + " "
        + this.theme.fg(entry.tone, `[${entry.status}]`)
        + " "
        + this.theme.fg("text", entry.title);
      this.addChild(new Text(truncateToWidth(text, width), 0, 0));
    }
    this.width = width;
    this.dirty = false;
  }
}

export class NeoStatusController {
  private context?: ExtensionContext;
  private source?: NeoUiSource;
  private timer?: ReturnType<typeof setInterval>;
  private sourceKey?: string;
  private renderKey?: string;
  private model: NeoUiModel = { status: "Neo · 0/0 todo", entries: [] };
  private readonly bindings = new Set<WidgetBinding>();
  private widgetRegistered = false;

  start(context: ExtensionContext, source: NeoUiSource): void {
    this.stop();
    if (!context.hasUI) return;
    this.context = context;
    this.source = source;

    if (context.mode === "tui") {
      context.ui.setWidget(NEO_WIDGET_KEY, (tui, theme) => {
        let binding: WidgetBinding;
        const widget = new NeoStatusWidget(
          () => this.model.entries,
          theme,
          () => this.bindings.delete(binding),
        );
        binding = { tui, widget };
        this.bindings.add(binding);
        return widget;
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    }

    this.refresh();
    this.timer = setInterval(() => this.refresh(), NEO_STATUS_INTERVAL_MS);
    this.timer.unref?.();
  }

  refresh(): boolean {
    if (!this.context || !this.source) return false;
    const snapshot = this.source.store.getSnapshot();
    const children = this.source.runtime.status();
    const sourceKey = JSON.stringify([
      snapshot.revision,
      [...children]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((child) => [child.id, child.status, child.runId, child.nodeId, child.agentType]),
    ]);
    if (sourceKey === this.sourceKey) return false;

    const nextModel = createNeoUiModel(snapshot, children);
    const renderKey = JSON.stringify(nextModel);
    const firstRender = this.renderKey === undefined;
    this.sourceKey = sourceKey;
    if (renderKey === this.renderKey) return false;

    const previousModel = this.model;
    this.model = nextModel;
    this.renderKey = renderKey;
    if (firstRender || previousModel.status !== nextModel.status) {
      this.context.ui.setStatus(NEO_STATUS_KEY, nextModel.status);
    }
    if (JSON.stringify(previousModel.entries) !== JSON.stringify(nextModel.entries)) {
      for (const { tui, widget } of this.bindings) {
        widget.invalidate();
        tui.requestRender();
      }
    }
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.context) {
      this.context.ui.setStatus(NEO_STATUS_KEY, undefined);
      if (this.widgetRegistered) this.context.ui.setWidget(NEO_WIDGET_KEY, undefined);
    }
    this.bindings.clear();
    this.context = undefined;
    this.source = undefined;
    this.sourceKey = undefined;
    this.renderKey = undefined;
    this.model = { status: "Neo · 0/0 todo", entries: [] };
    this.widgetRegistered = false;
  }
}
