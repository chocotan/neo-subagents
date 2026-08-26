import { describe, expect, it } from "vitest";
import neoExtension from "../../src/extension.js";

describe("Neo extension registration", () => {
  it("registers the /neo command and main neo control tool", () => {
    const commands = new Map<string, unknown>();
    const tools = new Map<string, unknown>();
    const pi = {
      registerCommand(name: string, config: unknown) { commands.set(name, config); },
      registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
      on() { return undefined; },
    };

    neoExtension(pi as never);

    expect(commands.has("neo")).toBe(true);
    expect(tools.has("neo")).toBe(true);
  });
});
