import { homedir } from "node:os";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import type { Profile } from "../domain/types.js";

interface ProfileDocument { name?: string; description?: string; focus?: string[]; recommendedSkills?: string[]; discoverScopes?: string[]; useParentSkills?: unknown; recommendedAgents?: string[]; communicationStyle?: string; memoryScope?: string; recommendedWorkflows?: string[]; }

export interface ProfileDiagnostic {
  sourcePath: string;
  reason: string;
}

function parseUseParentSkills(value: unknown, sourcePath: string): "*" | undefined {
  if (value === undefined) return undefined;
  if (value === "*") return "*";
  throw new Error(`${sourcePath}: useParentSkills must be "*" when configured`);
}

export class ProfileLoader {
  private readonly invalidProfiles: ProfileDiagnostic[] = [];

  constructor(private readonly cwd: string) {}
  getDiagnostics(): readonly ProfileDiagnostic[] { return this.invalidProfiles; }
  async list(): Promise<Profile[]> {
    this.invalidProfiles.length = 0;
    const files = await this.files();
    const profiles: Profile[] = [];
    for (const file of files) {
      try {
        const doc = YAML.parse(await readFile(file, "utf8")) as ProfileDocument;
        const useParentSkills = parseUseParentSkills(doc.useParentSkills, file);
        const name = doc.name ?? file.split("/").pop()?.replace(/\.(yaml|yml|json)$/i, "") ?? "profile";
        profiles.push({ name, description: doc.description ?? "", focus: doc.focus ?? [], recommendedSkills: doc.recommendedSkills ?? [], discoverScopes: doc.discoverScopes ?? [], useParentSkills, recommendedAgents: doc.recommendedAgents ?? [], communicationStyle: doc.communicationStyle, memoryScope: doc.memoryScope, recommendedWorkflows: doc.recommendedWorkflows ?? [], sourcePath: file });
      } catch (error) {
        this.invalidProfiles.push({ sourcePath: file, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return profiles.sort((a, b) => a.name.localeCompare(b.name));
  }
  async get(name: string): Promise<Profile | undefined> { return (await this.list()).find((profile) => profile.name === name); }
  private async files(): Promise<string[]> {
    const roots = [join(this.cwd, ".pi", "profiles"), join(homedir(), ".pi", "agent", "profiles")];
    const result: string[] = [];
    for (const root of roots) {
      try { for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isFile() && /\.(yaml|yml|json)$/i.test(entry.name)) result.push(resolve(root, entry.name)); } catch { /* optional */ }
    }
    return result;
  }
}

export function isCompatibleProfile(profile: Profile | undefined, workflowName?: string): boolean {
  return Boolean(profile && (!workflowName || profile.recommendedWorkflows.includes(workflowName)));
}

export async function loadProfileContext(cwd: string, activeProfile: string | undefined, workflowName?: string): Promise<import("../domain/types.js").ExecutionContext> {
  const profile = activeProfile ? await new ProfileLoader(cwd).get(activeProfile) : undefined;
  const compatibleProfile = isCompatibleProfile(profile, workflowName) ? profile : undefined;
  return {
    cwd,
    profile: compatibleProfile,
    workflowName,
    skills: [],
    useParentSkills: compatibleProfile?.useParentSkills,
    inheritedSkillCount: 0,
    temporary: Boolean(workflowName && !compatibleProfile),
  };
}
