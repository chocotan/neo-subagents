import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { WorkflowNode } from "../domain/types.js";

export interface ShellExecution { command: string; args: string[]; cwd: string; env: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; }
export interface ShellResult extends ExecResult { command: string; cwd: string; env: Record<string, string>; }
export type PiExec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;
export class ShellExecutor {
  constructor(private readonly exec: PiExec) {}
  async execute(node: WorkflowNode, cwd: string, signal?: AbortSignal): Promise<ShellResult> {
    const env = node.env ?? {};
    const command = node.command ?? "";
    const args = node.args ?? [];
    const invocation = Object.keys(env).length ? ["-c", `exec "$0" "$@"`, command, ...args] : args;
    const executable = Object.keys(env).length ? "env" : command;
    const envArgs = Object.keys(env).length ? [...Object.entries(env).map(([key, value]) => `${key}=${value}`), ...invocation] : invocation;
    const options: ExecOptions = { cwd: node.cwd ? resolveCwd(cwd, node.cwd) : cwd };
    if (node.timeoutMs !== undefined) options.timeout = node.timeoutMs;
    if (signal) options.signal = signal;
    const result = await this.exec(executable, envArgs, options);
    return { ...result, command: [command, ...args].join(" "), cwd: node.cwd ? resolveCwd(cwd, node.cwd) : cwd, env };
  }
}
function resolveCwd(base: string, value: string): string { return value.startsWith("/") ? value : `${base}/${value}`; }
