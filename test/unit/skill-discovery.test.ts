import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillDiscovery, resolveSkills } from "../../src/skills/skill-discovery.js";
import type { Profile } from "../../src/domain/types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function skill(root: string, name: string, content: string, nested = true): Promise<void> {
  const dir = nested ? join(root, name) : root;
  await mkdir(dir, { recursive: true });
  await writeFile(nested ? join(dir, "SKILL.md") : join(dir, `${name}.md`), content);
}

describe("SkillDiscovery parent catalog", () => {
  it("discovers project, ancestor, explicit, and global skills with project precedence", async () => {
    const base = await mkdtemp(join(tmpdir(), "neo-skills-"));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const cwd = join(base, "project");
    const projectPi = join(base, "project", ".pi", "skills");
    const ancestorAgents = join(base, ".agents", "skills");
    const scope = join(base, "scope");
    const agentDir = join(base, "pi-agent");
    const homeDir = join(base, "home");
    await skill(projectPi, "shared", "project shared");
    await skill(projectPi, "project-only", "project only");
    await skill(projectPi, "root-file", "root file", false);
    await skill(ancestorAgents, "shared", "ancestor shared");
    await skill(ancestorAgents, "ancestor-only", "ancestor only");
    await skill(scope, "shared", "scope shared");
    await skill(scope, "scope-only", "scope only");
    await skill(join(agentDir, "skills"), "shared", "global shared");
    await skill(join(agentDir, "skills"), "global-only", "global only");
    await skill(join(homeDir, ".agents", "skills"), "home-only", "home only");
    await skill(join(homeDir, ".agents", "skills"), "invalid", "");
    await skill(join(projectPi, "node_modules"), "ignored", "ignored");

    const catalog = await new SkillDiscovery(cwd, { agentDir, homeDir }).discoverAll([scope]);
    expect(catalog.map((entry) => entry.name).sort()).toEqual([
      "ancestor-only", "global-only", "home-only", "invalid", "project-only", "root-file", "scope-only", "shared",
    ]);
    expect(catalog.find((entry) => entry.name === "shared")).toMatchObject({ content: "project shared", source: join(projectPi, "shared", "SKILL.md") });
    expect(catalog.find((entry) => entry.name === "invalid")).toMatchObject({ status: "invalid", source: join(homeDir, ".agents", "skills", "invalid", "SKILL.md") });
  });

  it("inherits a valid profile catalog but never leaks an incompatible temporary profile", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "neo-skill-context-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    await skill(join(cwd, ".pi", "skills"), "parent-only", "parent only");
    const profile = { name: "parent", description: "", focus: [], recommendedSkills: [], discoverScopes: [], recommendedAgents: [], recommendedWorkflows: [], sourcePath: "profile", useParentSkills: "*" } satisfies Profile;

    const inherited = await resolveSkills({ cwd, profile, skills: [], temporary: false }, [], [], { agentDir: join(cwd, "empty-agent"), homeDir: join(cwd, "empty-home") });
    expect(inherited.skills.map((entry) => entry.name)).toEqual(["parent-only"]);
    expect(inherited).toMatchObject({ useParentSkills: "*", inheritedSkillCount: 1 });

    const temporary = await resolveSkills({ cwd, profile, skills: [], temporary: true }, []);
    expect(temporary.skills).toEqual([]);
    expect(temporary.useParentSkills).toBeUndefined();
    expect(temporary.inheritedSkillCount).toBe(0);
  });
});
