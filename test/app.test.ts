import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { chunks } from "../src/bot/telegram.js";
import { loadEnv } from "../src/config.js";
import type { ApprovalRecord } from "../src/gate/gate.js";
import type { LLMResult, Llm } from "../src/llm/chat.js";
import { JsonStore } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "ops-agent-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("end to end", () => {
  it("asks to delete, waits for approval, then deletes", async () => {
    const steps: LLMResult[] = [
      {
        type: "tool_calls",
        calls: [{ id: "c1", name: "delete_lead", args: { id: "L-002", reason: "duplicate" } }],
        rawMessage: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "delete_lead", arguments: "{}" } }] },
      },
      { type: "text", content: "Waiting for your approval to delete L-002." },
    ];
    const llm: Llm = async () => steps.shift()!;
    const app = createApp(loadEnv({}), { store: new JsonStore(), llm });
    const cards: ApprovalRecord[] = [];
    app.gate.setNotifier({ requestApproval: async (r) => void cards.push(r) });

    expect(await app.ask(1, "delete Kestrel, it's a duplicate")).toBe("Waiting for your approval to delete L-002.");
    expect(app.crm.lead("L-002")).toBeDefined();

    expect((await app.gate.resolve(cards[0]!.id, "ok")).text).toBe("Deleted L-002.");
    expect(app.crm.lead("L-002")).toBeUndefined();
  });

  it("explains instead of crashing when no model answers", async () => {
    const app = createApp(loadEnv({}), { store: new JsonStore(), llm: async () => Promise.reject(new Error("HTTP 503")) });
    expect(await app.ask(1, "hi")).toMatch(/^I couldn't reach an AI model just now \(HTTP 503\)/);
  });

  it("refuses to start with no model key", () => {
    expect(() => createApp(loadEnv({}), { store: new JsonStore() })).toThrow(/No model key set/);
  });
});

describe("config and storage", () => {
  it("treats empty values as unset and rejects unknown providers", () => {
    const env = loadEnv({ GEMINI_API_KEY: "", MAX_ITERATIONS: "8" });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.MAX_ITERATIONS).toBe(8);
    expect(() => loadEnv({ LLM_PROVIDER: "skynet" })).toThrow(/LLM_PROVIDER/);
  });

  it("saves to disk, reloads, and leaves no temp file behind", () => {
    const file = join(dir, "state.json");
    new JsonStore(file).set("llm.provider", "gemini");
    expect(new JsonStore(file).get("llm.provider")).toBe("gemini");
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("splits long replies for Telegram", () => {
    expect(chunks("a".repeat(9000)).map((c) => c.length)).toEqual([4000, 4000, 1000]);
    expect(chunks("")).toEqual([""]);
  });
});
