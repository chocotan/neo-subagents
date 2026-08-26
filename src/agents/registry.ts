import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface NeoAgentConfig {
  name: string;
  displayName: string;
  color: string;
  description: string;
  tools: readonly string[];
  model?: string;
  thinking: ThinkingLevel;
  maxTurns: number;
  systemPrompt: string;
  promptMode: "replace" | "append";
  useParentSkills?: "*";
}

const WORKER_PROMPT = `You are the implementation worker and the sole writer for the assigned task. Read the supplied context and actual code first, then implement the smallest complete change that follows existing patterns. Do not make unapproved product or architecture decisions. Validate with focused tests or checks, preserve unrelated user changes, and report changed files, validation, and residual risks. If a required decision is missing, stop and return the exact decision needed instead of guessing.`;

const SCOUT_PROMPT = `You are a scouting subagent. Move quickly but do not guess. Prefer targeted search and selective reading. Return the minimum context another agent needs: relevant entry points, key types and functions, data flow, dependencies, likely change locations, constraints, risks, and open questions. Cite exact file paths and line numbers. Do not edit files.`;

export const NEO_BUILTIN_AGENTS: readonly NeoAgentConfig[] = [
  {
    name: "worker",
    displayName: "Worker",
    color: "green",
    description: "General implementation agent and sole writer for an assigned task",
    tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    thinking: "high",
    maxTurns: 40,
    systemPrompt: WORKER_PROMPT,
    promptMode: "append",
    useParentSkills: "*",
  },
  {
    name: "scout",
    displayName: "Scout",
    color: "cyan",
    description: "Fast codebase reconnaissance and compressed context handoff",
    tools: ["read", "grep", "find", "ls", "bash"],
    thinking: "low",
    maxTurns: 20,
    systemPrompt: SCOUT_PROMPT,
    promptMode: "append",
    useParentSkills: "*",
  },
];

export function buildBuiltinAgentPrompt(config: NeoAgentConfig, cwd: string): string {
  const activeAgentTag = `<active_agent name="${config.name}"/>`;
  const environment = `# Environment\nWorking directory: ${cwd}\nPlatform: ${process.platform}`;
  const base = `# Role\nYou are a Neo coding sub-agent assigned one focused task. Follow the active Agent instructions and report evidence, validation, and uncertainty.`;
  const bridge = `<sub_agent_context>\nYou are operating as a sub-agent. Use only the tools exposed to this session. Preserve unrelated user changes. Do not spawn another Agent manager.\n</sub_agent_context>`;
  if (config.promptMode === "replace") return `${activeAgentTag}\n\n${environment}\n\n${config.systemPrompt}`;
  return `${base}\n\n${bridge}\n\n${activeAgentTag}\n\n${environment}\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`;
}

const registry = new Map(NEO_BUILTIN_AGENTS.map((agent) => [agent.name, agent]));

export function getBuiltinAgent(name: string): NeoAgentConfig | undefined {
  if (registry.has(name)) return registry.get(name);
  const lower = name.toLowerCase();
  return NEO_BUILTIN_AGENTS.find((agent) => agent.name.toLowerCase() === lower);
}

export function listBuiltinAgents(): readonly NeoAgentConfig[] {
  return NEO_BUILTIN_AGENTS;
}

export function formatBuiltinAgents(): string {
  return NEO_BUILTIN_AGENTS.map((agent) => `${agent.name} (${agent.displayName}): ${agent.description}`).join("\n");
}
