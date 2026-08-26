import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSkills } from "../../src/skills/skill-discovery.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

describe("skill discovery fallback", () => {
  it("returns missing optional skills without rejecting the context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "neo-skill-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, "custom", "available"), { recursive: true });
    await writeFile(join(cwd, "custom", "available", "SKILL.md"), "# Available\n\nUse fixture evidence.");
    const context = await resolveSkills({ cwd, skills: [], temporary: true }, ["available", "missing"], ["custom"]);
    expect(context.skills).toEqual([
      expect.objectContaining({ name: "available", status: "loaded" }),
      expect.objectContaining({ name: "missing", status: "missing" }),
    ]);
  });
});
