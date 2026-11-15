/**
 * A small key-value store saved as one JSON file.
 *
 * The production bot keeps this state in SQLite. A JSON file keeps this repo
 * free of native modules, so `npm install` works on any machine. Writes go to a
 * temp file first and are then renamed over the real one, so a crash mid-write
 * never leaves half a file behind.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class JsonStore {
  private data: Record<string, unknown> = {};

  /** With no file, the store lives in memory only (used by the tests). */
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      this.data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    }
  }

  get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  }

  set(key: string, value: unknown): void {
    if (value === undefined) delete this.data[key];
    else this.data[key] = value;
    this.flush();
  }

  /** Read, change and save one key in a single step. */
  update<T>(key: string, fallback: T, fn: (current: T) => T): T {
    const next = fn(this.get<T>(key) ?? fallback);
    this.set(key, next);
    return next;
  }

  private flush(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
