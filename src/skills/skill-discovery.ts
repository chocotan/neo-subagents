import { homedir } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExecutionContext, SkillResult } from "../domain/types.js";

export interface SkillSearchResult {
  name: string;
  source: string;
}

export interface SkillDiscoveryOptions {
  agentDir?: string;
  homeDir?: string;
  roots?: readonly string[];
}

export class SkillDiscovery {
  private readonly agentDir: string;
  private readonly homeDir: string;
  private readonly injectedRoots: readonly string[];

  constructor(private readonly cwd: string, options: SkillDiscoveryOptions = {}) {
    this.agentDir = resolve(options.agentDir ?? getAgentDir());
    this.homeDir = resolve(options.homeDir ?? homedir());
    this.injectedRoots = options.roots ?? [];
  }

  async discover(names: readonly string[], scopes: readonly string[] = []): Promise<SkillResult[]> {
    const roots = this.roots(scopes);
    const results: SkillResult[] = [];
    for (const name of names) {
      const candidates = roots.flatMap((root) => [join(root, name, "SKILL.md"), join(root, `${name}.md`)]);
      const file = await firstFile(candidates);
      if (!file) results.push({ name, status: "missing", reason: "No skill in the configured discovery scopes" });
      else results.push(await readSkill(name, file));
    }
    return results;
  }

  /** Discover every skill visible from the parent Pi environment. */
  async discoverAll(scopes: readonly string[] = []): Promise<SkillResult[]> {
    const matches = new Map<string, SkillResult>();
    for (const root of this.roots(scopes)) await this.collectRoot(root, matches);
    return [...matches.values()];
  }

  /** Alias used by callers that want to make the parent-catalog boundary explicit. */
  async discoverParentCatalog(scopes: readonly string[] = []): Promise<SkillResult[]> {
    return this.discoverAll(scopes);
  }

  async search(query: string, scopes: readonly string[] = []): Promise<SkillSearchResult[]> {
    const needle = query.trim().toLowerCase();
    return (await this.discoverAll(scopes))
      .filter((skill) => !needle || skill.name.toLowerCase().includes(needle))
      .filter((skill): skill is SkillResult & { source: string } => Boolean(skill.source))
      .map((skill) => ({ name: skill.name, source: skill.source }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private async collectRoot(root: string, matches: Map<string, SkillResult>): Promise<void> {
    if (isNodeModulesPath(root)) return;
    if (await isFile(root)) {
      if (root.toLowerCase().endsWith(".md")) await addSkill(matches, basename(root, ".md"), root);
      return;
    }
    await this.collectDirectory(root, matches);
  }

  private async collectDirectory(root: string, matches: Map<string, SkillResult>): Promise<void> {
    if (isNodeModulesPath(root)) return;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        const skillFile = join(path, "SKILL.md");
        if (await isFile(skillFile)) await addSkill(matches, entry.name, skillFile);
        else await this.collectDirectory(path, matches);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        await addSkill(matches, basename(entry.name, ".md"), path);
      }
    }
  }

  private roots(scopes: readonly string[]): string[] {
    const projectRoots = [
      join(this.cwd, ".pi", "skills"),
      ...ancestorRoots(this.cwd, ".agents", "skills"),
    ];
    const explicitRoots = [...this.injectedRoots, ...scopes].map((scope) => isAbsolute(scope) ? resolve(scope) : resolve(this.cwd, scope));
    const globalRoots = [join(this.agentDir, "skills"), join(this.homeDir, ".agents", "skills")];
    return [...new Set([...projectRoots, ...explicitRoots, ...globalRoots])].filter((root) => !isNodeModulesPath(root));
  }
}

async function addSkill(matches: Map<string, SkillResult>, name: string, file: string): Promise<void> {
  if (matches.has(name)) return;
  matches.set(name, await readSkill(name, file));
}

async function readSkill(name: string, file: string): Promise<SkillResult> {
  try {
    const content = await readFile(file, "utf8");
    const trimmed = content.trim();
    return trimmed
      ? { name, status: "loaded", source: file, content: trimmed }
      : { name, status: "invalid", source: file, reason: "Empty skill" };
  } catch (error) {
    return { name, status: "unreadable", source: file, reason: error instanceof Error ? error.message : String(error) };
  }
}

function ancestorRoots(start: string, ...parts: string[]): string[] {
  const roots: string[] = [];
  let current = resolve(start);
  while (true) {
    roots.push(join(current, ...parts));
    const parent = dirname(current);
    if (parent === current) return roots;
    current = parent;
  }
}

function isNodeModulesPath(path: string): boolean {
  return path.split(sep).includes("node_modules");
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function firstFile(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) if (await isFile(path)) return path;
  return undefined;
}

export async function resolveSkills(
  context: ExecutionContext,
  requested: readonly string[],
  additionalScopes: readonly string[] = [],
  discoveryOptions: SkillDiscoveryOptions = {},
): Promise<ExecutionContext> {
  const profileScopes = context.temporary ? [] : (context.profile?.discoverScopes ?? []);
  const scopes = [...new Set([...profileScopes, ...additionalScopes])];
  const discovery = new SkillDiscovery(context.cwd, discoveryOptions);
  const requestedSkills = await discovery.discover(requested, scopes);
  const inheritParentSkills = !context.temporary && context.profile?.useParentSkills === "*";
  const parentSkills = inheritParentSkills ? await discovery.discoverAll(scopes) : [];
  const skills = dedupeSkills([...requestedSkills, ...parentSkills]);
  return {
    ...context,
    discoverScopes: scopes,
    useParentSkills: inheritParentSkills ? "*" : undefined,
    inheritedSkillCount: parentSkills.length,
    skills,
  };
}

function dedupeSkills(skills: readonly SkillResult[]): SkillResult[] {
  const unique = new Map<string, SkillResult>();
  for (const skill of skills) if (!unique.has(skill.name)) unique.set(skill.name, skill);
  return [...unique.values()];
}
