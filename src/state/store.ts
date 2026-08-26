import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { emptySnapshot, reduceSnapshot } from "../domain/reducer.js";
import type { NeoEvent, NeoSnapshot } from "../domain/types.js";

export function stableId(kind: string): string { return `neo_${kind}_${randomUUID()}`; }

export class NeoStateStore {
  readonly directory: string;
  readonly eventsPath: string;
  readonly snapshotPath: string;
  private snapshot: NeoSnapshot;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(directory: string, snapshot: NeoSnapshot) {
    this.directory = directory;
    this.eventsPath = join(directory, "events.jsonl");
    this.snapshotPath = join(directory, "snapshot.json");
    this.snapshot = snapshot;
  }

  static async open(cwd: string, directory?: string): Promise<NeoStateStore> {
    const dir = directory ?? join(cwd, ".pi", "neo");
    await mkdir(dir, { recursive: true });
    let snapshot = emptySnapshot();
    try { snapshot = JSON.parse(await readFile(join(dir, "snapshot.json"), "utf8")) as NeoSnapshot; } catch { /* first run */ }
    try {
      const text = await readFile(join(dir, "events.jsonl"), "utf8");
      const events = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as NeoEvent);
      const seen = new Set(snapshot.events.map((event) => event.id));
      for (const event of events) if (!seen.has(event.id)) snapshot = reduceSnapshot(snapshot, event);
    } catch { /* first run */ }
    return new NeoStateStore(dir, snapshot);
  }

  getSnapshot(): NeoSnapshot { return structuredClone(this.snapshot); }

  async append(type: string, payload: Record<string, unknown>): Promise<NeoEvent> {
    const event: NeoEvent = { id: stableId("event"), type, timestamp: new Date().toISOString(), payload };
    this.snapshot = reduceSnapshot(this.snapshot, event);
    this.writeQueue = this.writeQueue.then(async () => {
      await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
      const temporary = `${this.snapshotPath}.tmp`;
      await writeFile(temporary, JSON.stringify(this.snapshot, null, 2), "utf8");
      await rename(temporary, this.snapshotPath);
    });
    await this.writeQueue;
    return event;
  }

  async flush(): Promise<void> { await this.writeQueue; }
}
