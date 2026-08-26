import { describe, expect, it } from "vitest";
import { getBuiltinAgent, listBuiltinAgents } from "../../src/agents/registry.js";

describe("Neo built-in agent registry", () => {
  it("contains only the migrated worker and scout definitions", () => {
    expect(listBuiltinAgents().map((agent) => agent.name)).toEqual(["worker", "scout"]);
    expect(getBuiltinAgent("worker")).toMatchObject({
      displayName: "Worker",
      color: "green",
      promptMode: "append",
      thinking: "high",
      maxTurns: 40,
      tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      useParentSkills: "*",
    });
    expect(getBuiltinAgent("scout")).toMatchObject({
      displayName: "Scout",
      color: "cyan",
      promptMode: "append",
      thinking: "low",
      maxTurns: 20,
      tools: ["read", "grep", "find", "ls", "bash"],
      useParentSkills: "*",
    });
    expect(getBuiltinAgent("worker")?.systemPrompt).toContain("sole writer");
    expect(getBuiltinAgent("scout")?.systemPrompt).toContain("Do not edit files");
    expect(getBuiltinAgent("general-purpose")).toBeUndefined();
    expect(getBuiltinAgent("Explore")).toBeUndefined();
    expect(getBuiltinAgent("Plan")).toBeUndefined();
  });
});
