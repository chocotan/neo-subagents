import { describe, expect, it } from "vitest";
import { splitArgs } from "../../src/command.js";

describe("splitArgs", () => {
  it("parses quoted values and escaped quotes", () => {
    expect(splitArgs(`workflow add run node shell title="Release check" command='node' prompt="say \\"ok\\""`)).toEqual([
      "workflow", "add", "run", "node", "shell", "title=Release check", "command=node", `prompt=say "ok"`,
    ]);
  });

  it("keeps key=value workflow inputs intact", () => {
    expect(splitArgs("workflow run harmless-release project=shop-api empty="))
      .toEqual(["workflow", "run", "harmless-release", "project=shop-api", "empty="]);
  });
});
