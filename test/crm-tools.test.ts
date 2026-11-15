import { describe, expect, it } from "vitest";
import { Crm } from "../src/crm/crm.js";
import { ApprovalGate, type ApprovalRecord } from "../src/gate/gate.js";
import { JsonStore } from "../src/store.js";
import { crmTools } from "../src/tools/crm.js";
import { ToolRegistry } from "../src/tools/registry.js";

const SEEDED = new Date("2026-11-17T10:00:00Z"); // a Tuesday, 11:00 in Lagos

function setup(now: Date = SEEDED) {
  const store = new JsonStore();
  const crm = new Crm(store, SEEDED);
  const gate = new ApprovalGate(store);
  const cards: ApprovalRecord[] = [];
  gate.setNotifier({ requestApproval: async (r) => void cards.push(r) });
  const tools = new ToolRegistry(gate).add(...crmTools(crm, () => now));
  return { crm, gate, cards, tools };
}

describe("CRM tools", () => {
  it("lists what is due today, with each lead's window", async () => {
    const out = await setup().tools.execute("today_queue", {});
    expect(out.split("\n")[0]).toBe("10 due:");
    expect(out).toContain("L-001 Northwind Freight (Ada Okafor): new, touch 0, Open until 17:00 Lagos");
    expect(out).toContain("L-004 Brightloom Studios (Oliver Grant): contacted, touch 1, Open until 18:00 Lagos (17:00 UK)");
    expect(out).toContain("L-008 Tidewater Logistics (Dana Reyes): contacted, touch 1, Opens 15:00 Lagos (09:00 ET)");
    expect(out).not.toContain("L-003");
  });

  it("logs a touch inside hours and schedules the next one on a working day", async () => {
    const { crm, tools } = setup();
    expect(await tools.execute("log_touch", { id: "L-001", channel: "email" })).toBe(
      "Logged touch 1 to Northwind Freight by email. Next touch: Thu 19 Nov.",
    );
    expect(crm.lead("L-001")).toMatchObject({ status: "contacted", touchCount: 1, nextActionDate: "2026-11-19T08:00:00.000Z" });
  });

  it("skips public holidays when scheduling", async () => {
    const { crm, tools } = setup(new Date("2026-12-24T10:00:00Z"));
    await tools.execute("log_touch", { id: "L-001", channel: "phone" });
    // 25 Dec and 28 Dec are holidays, 26 to 27 Dec is a weekend.
    expect(crm.lead("L-001")?.nextActionDate).toBe("2026-12-30T08:00:00.000Z");
  });

  it("refuses to log a touch outside the lead's working hours", async () => {
    const { crm, tools } = setup();
    // 05:00 in New York.
    expect(await tools.execute("log_touch", { id: "L-003", channel: "email" })).toBe(
      "Locked: Harbor & Pine Legal is outside working hours (before). Opens 15:00 Lagos (09:00 ET). Nothing was logged.",
    );
    expect(crm.touches("L-003")).toEqual([]);

    const weekend = setup(new Date("2026-11-14T10:00:00Z"));
    expect(await weekend.tools.execute("log_touch", { id: "L-001", channel: "email" })).toMatch(/^Locked: .*\(weekend\)/);
  });

  it("deletes only after approval", async () => {
    const { crm, cards, gate, tools } = setup();
    expect(await tools.execute("delete_lead", { id: "L-002", reason: "duplicate" })).toMatch(/^QUEUED FOR APPROVAL/);
    expect(cards[0]!.summary).toBe("Delete L-002 (Kestrel Clinics) and its history. Reason: duplicate");
    expect(crm.lead("L-002")).toBeDefined();

    await gate.resolve(cards[0]!.id, "ok");
    expect(crm.lead("L-002")).toBeUndefined();
  });

  it("gates bulk changes over 10 leads only", async () => {
    const { crm, tools } = setup();
    expect(await tools.execute("bulk_update_status", { ids: ["L-001", "L-002", "L-099"], status: "lost" })).toBe(
      "Set 2 to lost. Not found: L-099.",
    );
    expect(crm.lead("L-001")?.status).toBe("lost");

    const eleven = Array.from({ length: 11 }, (_, i) => `L-${String(i + 1).padStart(3, "0")}`);
    expect(await tools.execute("bulk_update_status", { ids: eleven, status: "won" })).toMatch(/^QUEUED FOR APPROVAL/);
    expect(crm.lead("L-005")?.status).not.toBe("won");
  });

  it("keeps notes with the date", async () => {
    const { crm, tools } = setup();
    await tools.execute("update_status", { id: "L-004", status: "replied", note: "Asked for pricing" });
    expect(crm.lead("L-004")?.notes).toEqual(["2026-11-17: Asked for pricing"]);
    expect(await tools.execute("get_lead", { id: "l-004" })).toContain("Asked for pricing");
  });
});
