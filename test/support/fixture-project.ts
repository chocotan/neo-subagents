import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function createFixtureProject(): Promise<{ cwd: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), "neo-test-"));
  await mkdir(join(cwd, ".pi", "workflows"), { recursive: true });
  await mkdir(join(cwd, ".pi", "profiles"), { recursive: true });
  const root = new URL("../fixtures/", import.meta.url);
  await writeFile(join(cwd, ".pi", "workflows", "harmless-release.yaml"), await readFile(new URL("workflows/harmless-release.yaml", root), "utf8"));
  await writeFile(join(cwd, ".pi", "profiles", "fullstack.yaml"), await readFile(new URL("profiles/fullstack.yaml", root), "utf8"));
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
