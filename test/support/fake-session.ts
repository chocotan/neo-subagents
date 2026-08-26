import type { AgentSession, AgentSessionEvent, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { SessionFactory } from "../../src/runtime/native-runtime.js";

export interface FakeToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface FakeBehavior {
  output?: string;
  error?: string;
  waitFor?: Promise<void>;
  toolCalls?: FakeToolCall[];
}

export interface FakeSessionHarness {
  factory: SessionFactory;
  options: CreateAgentSessionOptions[];
  sessions: AgentSession[];
  toolResults: Array<{ name: string; result: unknown }>;
  prompts: string[];
  abortCount: number;
  disposeCount: number;
}

export function createFakeSessionHarness(behaviors: FakeBehavior[] = []): FakeSessionHarness {
  const options: CreateAgentSessionOptions[] = [];
  const sessions: AgentSession[] = [];
  let index = 0;
  const harness: FakeSessionHarness = {
    options,
    sessions,
    toolResults: [],
    prompts: [],
    abortCount: 0,
    disposeCount: 0,
    factory: async (input) => {
      options.push(input);
      const behavior = behaviors[index++] ?? {};
      const listeners = new Set<(event: AgentSessionEvent) => void>();
      let streaming = false;
      let stopped = false;
      const state: { errorMessage?: string } = {};
      const messages: unknown[] = [];
      const emit = (event: AgentSessionEvent): void => { for (const listener of listeners) listener(event); };
      const session = {
        sessionId: `fake-session-${index}`,
        sessionFile: input.sessionManager?.getSessionFile(),
        agent: { state, waitForIdle: async () => undefined },
        messages,
        get isStreaming() { return streaming; },
        subscribe(listener: (event: AgentSessionEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        async prompt(text: string) {
          harness.prompts.push(text);
          streaming = true;
          stopped = false;
          state.errorMessage = undefined;
          emit({ type: "agent_start" } as AgentSessionEvent);
          if (behavior.waitFor) await behavior.waitFor;
          if (stopped) return;
          for (const [callIndex, call] of (behavior.toolCalls ?? []).entries()) {
            const definition = input.customTools?.find((tool) => tool.name === call.name);
            if (!definition) throw new Error(`Fake session tool not registered: ${call.name}`);
            const callable = definition as unknown as {
              execute: (toolCallId: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, context: never) => Promise<unknown>;
            };
            const result = await callable.execute(`fake-tool-${index}-${callIndex}`, call.arguments, undefined, undefined, {} as never);
            harness.toolResults.push({ name: call.name, result });
          }
          if (behavior.output) {
            emit({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: behavior.output } } as AgentSessionEvent);
          }
          if (behavior.error) state.errorMessage = behavior.error;
          const assistant = { role: "assistant", stopReason: behavior.error ? "error" : "stop", errorMessage: behavior.error };
          messages.push(assistant);
          emit({ type: "agent_end", messages: [assistant], willRetry: false } as AgentSessionEvent);
          streaming = false;
        },
        async steer() { return undefined; },
        async followUp() { return undefined; },
        async abort() { stopped = true; streaming = false; harness.abortCount += 1; },
        compact: async () => ({}),
        dispose() { harness.disposeCount += 1; listeners.clear(); },
      } as unknown as AgentSession;
      sessions.push(session);
      return { session };
    },
  };
  return harness;
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
