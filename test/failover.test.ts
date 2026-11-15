import { describe, expect, it } from "vitest";
import { Failover, statusOf } from "../src/llm/failover.js";
import { httpError, makeProviders } from "./helpers.js";

describe("failover", () => {
  it("moves to the next model on a 503 and stays there until reset", async () => {
    const { providers } = makeProviders(["openrouter"], "openrouter");
    const failover = new Failover(providers);
    const [first, second] = providers.spec().chain;
    const seen: string[] = [];

    const out = await failover.run(async (model) => {
      seen.push(model);
      if (model === first) throw httpError(503);
      return "ok";
    });

    expect(out).toBe("ok");
    expect(seen).toEqual([first, second]);
    expect(failover.activeModel()).toBe(second);
    expect(failover.reset()).toBe(true);
    expect(failover.activeModel()).toBe(first);
  });

  it("retries once on another provider when the active one fails outright, without changing the saved choice", async () => {
    const { providers } = makeProviders(["gemini", "openrouter"], "openrouter");
    const failover = new Failover(providers);
    const servedBy: string[] = [];

    const out = await failover.run(async () => {
      servedBy.push(providers.callId());
      if (providers.callId() === "openrouter") throw httpError(403);
      return "answered";
    });

    expect(out).toBe("answered");
    expect(servedBy).toEqual(["openrouter", "gemini"]);
    expect(providers.activeId()).toBe("openrouter");
  });

  it("does not walk the chain on a non-retriable error", async () => {
    const { providers } = makeProviders(["openrouter"], "openrouter");
    const failover = new Failover(providers);
    let calls = 0;
    await expect(
      failover.run(async () => {
        calls += 1;
        throw httpError(400);
      }),
    ).rejects.toThrow("HTTP 400");
    expect(calls).toBe(1);
  });

  it("throws the last error when every model everywhere is rate limited, and resets its position", async () => {
    const { providers } = makeProviders(["gemini", "openrouter"], "openrouter");
    const failover = new Failover(providers);
    const first = failover.activeModel();
    await expect(failover.run(async () => Promise.reject(httpError(429)))).rejects.toThrow("HTTP 429");
    expect(failover.activeModel()).toBe(first);
  });

  it("refuses to switch to a provider with no key", () => {
    const { providers } = makeProviders(["gemini"]);
    const failover = new Failover(providers);
    expect(failover.switchProvider("openai")).toMatch(/no API key/);
    expect(providers.activeId()).toBe("gemini");
  });

  it("reads the status from either field", () => {
    expect(statusOf({ status: 502 })).toBe(502);
    expect(statusOf({ statusCode: 500 })).toBe(500);
    expect(statusOf(new Error("x"))).toBeUndefined();
  });
});
