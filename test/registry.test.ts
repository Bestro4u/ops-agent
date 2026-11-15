import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApprovalGate, type ApprovalRecord } from "../src/gate/gate.js";
import { JsonStore } from "../src/store.js";
import { ToolRegistry, defineTool } from "../src/tools/registry.js";

function setup() {
  const gate = new ApprovalGate(new JsonStore());
  const cards: ApprovalRecord[] = [];
  gate.setNotifier({ requestApproval: async (r) => void cards.push(r) });
  const archive = vi.fn(({ ids }: { ids: string[] }) => `archived ${ids.length}`);
  const registry = new ToolRegistry(gate).add(
    defineTool({
      name: "archive",
      description: "Archive records.",
      schema: z.object({ ids: z.array(z.string()).min(1) }),
      gate: ({ ids }) => ids.length > 10,
      run: archive,
    }),
    defineTool({
      name: "explode",
      description: "Always throws.",
      schema: z.object({}),
      run: () => {
        throw new Error("boom");
      },
    }),
  );
  return { gate, cards, archive, registry };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);

describe("tool registry", () => {
  it("gives the model a clean JSON Schema", () => {
    const def = setup().registry.definitions()[0]!;
    expect(def.function.name).toBe("archive");
    const params = def.function.parameters as Record<string, any>;
    expect(params.properties.ids.type).toBe("array");
    expect(JSON.stringify(params)).not.toMatch(/\$schema|additionalProperties/);
  });

  it("returns bad input to the model as a fixable error and never runs the tool", async () => {
    const { registry, archive } = setup();
    expect(await registry.execute("archive", { ids: [] })).toMatch(/^Invalid arguments for archive: ids:/);
    expect(await registry.execute("archive", { _unparsed_arguments: "{ids:" })).toMatch(/^Invalid arguments/);
    expect(archive).not.toHaveBeenCalled();
  });

  it("names the real tools when the model invents one", async () => {
    expect(await setup().registry.execute("teleport", {})).toBe('Unknown tool "teleport". Use one of: archive, explode.');
  });

  it("runs small changes straight away and gates big ones", async () => {
    const { registry, archive, cards, gate } = setup();
    expect(await registry.execute("archive", { ids: ids(3) })).toBe("archived 3");
    expect(await registry.execute("archive", { ids: ids(11) })).toMatch(/^QUEUED FOR APPROVAL/);
    expect(archive).toHaveBeenCalledTimes(1);

    expect((await gate.resolve(cards[0]!.id, "ok")).text).toBe("archived 11");
    expect(archive).toHaveBeenCalledTimes(2);
  });

  it("turns a crash into a message", async () => {
    expect(await setup().registry.execute("explode", {})).toBe("explode failed: boom");
  });
});
