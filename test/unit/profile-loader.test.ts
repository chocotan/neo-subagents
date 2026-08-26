import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileLoader } from "../../src/profiles/profile-loader.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

describe("ProfileLoader useParentSkills", () => {
  it("parses the wildcard and records invalid values without enabling inheritance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "neo-profile-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, ".pi", "profiles"), { recursive: true });
    await writeFile(join(cwd, ".pi", "profiles", "parent.yaml"), "name: parent\nuseParentSkills: \"*\"\n");
    await writeFile(join(cwd, ".pi", "profiles", "invalid.yaml"), "name: invalid\nuseParentSkills: true\n");

    const loader = new ProfileLoader(cwd);
    await expect(loader.list()).resolves.toEqual([
      expect.objectContaining({ name: "parent", useParentSkills: "*" }),
    ]);
    expect(loader.getDiagnostics()).toEqual([
      expect.objectContaining({ sourcePath: join(cwd, ".pi", "profiles", "invalid.yaml"), reason: expect.stringContaining("must be \"*\"") }),
    ]);
  });
});
