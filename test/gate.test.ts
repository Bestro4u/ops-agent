import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_TTL_MS, ApprovalGate, type ApprovalRecord } from "../src/gate/gate.js";
import { JsonStore } from "../src/store.js";

describe("approval gate", () => {
  let clock: number;
  let gate: ApprovalGate;
  let cards: ApprovalRecord[];
  const handler = vi.fn(async (args: Record<string, unknown>) => `deleted ${String(args.id)}`);

  beforeEach(() => {
    clock = 1_000_000;
    cards = [];
    handler.mockClear();
    gate = new ApprovalGate(new JsonStore(), () => clock);
    gate.setNotifier({ requestApproval: async (r) => void cards.push(r) });
    gate.register("delete_lead", handler);
  });

  it("queues without running, and says so to the model", async () => {
    const text = await gate.queue("delete_lead", "Delete L-001", { id: "L-001" });
    expect(text).toMatch(/^QUEUED FOR APPROVAL/);
    expect(text).toContain("Nothing has happened yet");
    expect(handler).not.toHaveBeenCalled();
    expect(cards).toHaveLength(1);
    expect(gate.pending()).toHaveLength(1);
  });

  it("runs once on Approve, even if tapped twice", async () => {
    await gate.queue("delete_lead", "Delete L-001", { id: "L-001" });
    const id = cards[0]!.id;
    expect(await gate.resolve(id, "ok")).toEqual({ text: "deleted L-001", ran: true });
    expect(await gate.resolve(id, "ok")).toEqual({ text: "Already approved. Nothing more to do.", ran: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("never runs on Reject", async () => {
    await gate.queue("delete_lead", "Delete L-001", { id: "L-001" });
    const r = await gate.resolve(cards[0]!.id, "no");
    expect(r.ran).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses an approval older than 24 hours", async () => {
    await gate.queue("delete_lead", "Delete L-001", { id: "L-001" });
    clock += ACTION_TTL_MS + 1;
    const r = await gate.resolve(cards[0]!.id, "ok");
    expect(r.text).toMatch(/^Expired/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses tools it has no handler for, and works without a notifier only by refusing", async () => {
    expect(await gate.queue("wipe_everything", "x", {})).toMatch(/^Gate error: no handler/);
    const bare = new ApprovalGate(new JsonStore());
    bare.register("delete_lead", handler);
    expect(await bare.queue("delete_lead", "x", {})).toMatch(/^Gate error: no way to ask/);
  });

  it("marks the request rejected if the card cannot be sent", async () => {
    gate.setNotifier({ requestApproval: async () => Promise.reject(new Error("chat not found")) });
    const text = await gate.queue("delete_lead", "Delete L-001", { id: "L-001" });
    expect(text).toContain("chat not found");
    expect(gate.pending()).toHaveLength(0);
  });

  it("reports a failing action instead of throwing", async () => {
    gate.register("delete_lead", async () => Promise.reject(new Error("row is locked")));
    await gate.queue("delete_lead", "Delete L-001", { id: "L-001" });
    expect((await gate.resolve(cards[0]!.id, "ok")).text).toBe("Approved, but delete_lead failed: row is locked");
  });

  it("answers plainly for an unknown id", async () => {
    expect((await gate.resolve("0000000000", "ok")).text).toBe("That approval no longer exists.");
  });
});
