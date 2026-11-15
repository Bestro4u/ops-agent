import { describe, expect, it, vi } from "vitest";
import { JsonStore } from "../src/store.js";
import { Watchdog, type CheckResult } from "../src/watchdog/watchdog.js";

function setup() {
  const state = { ok: true, notice: undefined as string | undefined };
  const mitigate = vi.fn(async () => "reconnected");
  const alerts: string[] = [];
  const dog = new Watchdog(new JsonStore(), async (t) => void alerts.push(t), [
    async (): Promise<CheckResult> => ({ name: "Database", ok: state.ok, detail: state.ok ? "ok" : "timeout", mitigate, notice: state.notice }),
  ]);
  return { state, mitigate, alerts, dog };
}

describe("watchdog alert policy", () => {
  it("fixes a first failure quietly", async () => {
    const { state, mitigate, alerts, dog } = setup();
    state.ok = false;
    const r = await dog.sweep();
    expect(mitigate).toHaveBeenCalledTimes(1);
    expect(r.fixes).toEqual(["Database: reconnected"]);
    expect(alerts).toEqual([]);
  });

  it("speaks once when the fix didn't hold, escalates once, then stays quiet", async () => {
    const { state, mitigate, alerts, dog } = setup();
    state.ok = false;
    for (let i = 0; i < 5; i++) await dog.sweep();
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatch(/still failing after an automatic fix \(timeout\)/);
    expect(alerts[1]).toMatch(/failed 3 checks in a row.*retries are paused/);
    expect(mitigate).toHaveBeenCalledTimes(3);
  });

  it("says 'working again' only to someone who was told it was down", async () => {
    const quiet = setup();
    quiet.state.ok = false;
    await quiet.dog.sweep();
    quiet.state.ok = true;
    await quiet.dog.sweep();
    expect(quiet.alerts).toEqual([]);

    const told = setup();
    told.state.ok = false;
    await told.dog.sweep();
    await told.dog.sweep();
    told.state.ok = true;
    await told.dog.sweep();
    expect(told.alerts.at(-1)).toBe("Database is working again.");
  });

  it("always passes on a notice", async () => {
    const { state, alerts, dog } = setup();
    state.notice = "AI model switched to Google Gemini.";
    await dog.sweep();
    expect(alerts).toEqual(["AI model switched to Google Gemini."]);
  });

  it("treats a crashing check as a failure, not a crash", async () => {
    const dog = new Watchdog(new JsonStore(), async () => {}, [async () => Promise.reject(new Error("bug"))]);
    expect((await dog.sweep()).failing).toEqual(["watchdog"]);
  });
});
