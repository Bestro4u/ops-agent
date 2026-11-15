import { describe, expect, it } from "vitest";
import { AutoSwitch, HOME_OK_SWEEPS, type Probe } from "../src/llm/autoswitch.js";
import { Failover } from "../src/llm/failover.js";
import type { ProviderId } from "../src/llm/providers.js";
import { makeProviders } from "./helpers.js";

function setup(active: ProviderId = "openrouter") {
  const { providers, store } = makeProviders(["gemini", "openrouter", "openai"], active);
  const failover = new Failover(providers);
  const health: Record<ProviderId, boolean> = { gemini: true, openrouter: true, openai: true };
  const probe: Probe = async (id) => ({ id, healthy: health[id], detail: `${id} ${health[id] ? "ok" : "down"}` });
  const auto = new AutoSwitch(providers, failover, probe, store);
  return { providers, auto, health };
}

describe("provider auto-switch", () => {
  it("does nothing while the active provider is healthy", async () => {
    const { providers, auto } = setup();
    const r = await auto.check();
    expect(r).toMatchObject({ ok: true, notice: undefined });
    expect(providers.activeId()).toBe("openrouter");
  });

  it("switches to the first healthy provider and remembers home", async () => {
    const { providers, auto, health } = setup();
    health.openrouter = false;
    const r = await auto.check();
    expect(providers.activeId()).toBe("gemini");
    expect(auto.home()).toBe("openrouter");
    expect(r.notice).toContain("Replies now run on Google Gemini");
  });

  it(`switches back only after home answers on ${HOME_OK_SWEEPS} sweeps in a row`, async () => {
    const { providers, auto, health } = setup();
    health.openrouter = false;
    await auto.check();

    health.openrouter = true;
    expect((await auto.check()).notice).toBeUndefined();
    expect(providers.activeId()).toBe("gemini");

    const back = await auto.check();
    expect(providers.activeId()).toBe("openrouter");
    expect(back.notice).toContain("OpenRouter is answering again");
    expect(auto.home()).toBeNull();
  });

  it("restarts the count when home stumbles in between", async () => {
    const { providers, auto, health } = setup();
    health.openrouter = false;
    await auto.check();
    health.openrouter = true;
    await auto.check();
    health.openrouter = false;
    await auto.check();
    health.openrouter = true;
    await auto.check();
    expect(providers.activeId()).toBe("gemini");
  });

  it("reports every probe when nothing answers", async () => {
    const { providers, auto, health } = setup();
    health.gemini = health.openrouter = health.openai = false;
    const r = await auto.check();
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("openrouter down; gemini down; openai down");
    expect(providers.activeId()).toBe("openrouter");
  });

  it("lets a person's choice win: clear() stops the switch back", async () => {
    const { providers, auto, health } = setup();
    health.openrouter = false;
    await auto.check();
    auto.clear();
    health.openrouter = true;
    await auto.check();
    await auto.check();
    expect(providers.activeId()).toBe("gemini");
  });
});
