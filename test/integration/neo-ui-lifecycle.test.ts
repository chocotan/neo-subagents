import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import neoExtension from "../../src/extension.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Neo UI lifecycle", () => {
  it("registers once, coexists with other keys, refreshes commands, and cleans up", async () => {
    vi.useFakeTimers();
    const cwd = await mkdtemp(join(tmpdir(), "neo-ui-lifecycle-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));

    const handlers = new Map<string, Array<(event: never, context: never) => unknown>>();
    const commands = new Map<string, { handler: (args: string, context: ExtensionCommandContext) => Promise<void> }>();
    const statuses = new Map<string, string>([["pi-tasks", "tasks ready"]]);
    const widgets = new Map<string, { content: unknown; options?: { placement?: string } }>([
      ["subagents", { content: ["other widget"] }],
    ]);
    const widgetRegistrations: string[] = [];
    const notifications: string[] = [];

    const pi = {
      registerCommand(name: string, config: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> }) {
        commands.set(name, config);
      },
      registerTool() { return undefined; },
      on(name: string, handler: (event: never, context: never) => unknown) {
        const registered = handlers.get(name) ?? [];
        registered.push(handler);
        handlers.set(name, registered);
      },
      exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    };
    neoExtension(pi as never);

    expect(handlers.get("session_start")).toHaveLength(1);
    expect(handlers.get("session_shutdown")).toHaveLength(1);

    const ui = {
      setStatus(key: string, value: string | undefined) {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setWidget(key: string, content: unknown, options?: { placement?: string }) {
        if (content === undefined) widgets.delete(key);
        else {
          widgets.set(key, { content, options });
          widgetRegistrations.push(key);
        }
      },
      notify(message: string) { notifications.push(message); },
    };
    const context = {
      cwd,
      hasUI: true,
      mode: "tui",
      ui,
    } as unknown as ExtensionContext;

    const sessionStart = handlers.get("session_start")?.[0];
    expect(sessionStart).toBeDefined();
    await sessionStart?.({} as never, context as never);

    expect(statuses.get("neo-status")).toBe("Neo · 0/0 todo");
    expect(statuses.get("pi-tasks")).toBe("tasks ready");
    expect(widgets.get("neo")?.options).toEqual({ placement: "belowEditor" });
    expect(widgets.get("subagents")?.content).toEqual(["other widget"]);
    expect(widgetRegistrations.filter((key) => key === "neo")).toHaveLength(1);

    await commands.get("neo")?.handler("todo add lifecycle task", context as ExtensionCommandContext);
    expect(statuses.get("neo-status")).toBe("Neo · 0/1 todo");
    expect(notifications.at(-1)).toContain("Todo added:");
    expect(widgetRegistrations.filter((key) => key === "neo")).toHaveLength(1);

    const sessionShutdown = handlers.get("session_shutdown")?.[0];
    expect(sessionShutdown).toBeDefined();
    await sessionShutdown?.({} as never, context as never);
    vi.advanceTimersByTime(1_000);

    expect(statuses.has("neo-status")).toBe(false);
    expect(widgets.has("neo")).toBe(false);
    expect(statuses.get("pi-tasks")).toBe("tasks ready");
    expect(widgets.get("subagents")?.content).toEqual(["other widget"]);
  });
});
