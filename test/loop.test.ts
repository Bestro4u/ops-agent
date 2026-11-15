import { describe, expect, it } from "vitest";
import { z } from "zod";
import { budgetPressure, runAgent } from "../src/agent/loop.js";
import { ApprovalGate } from "../src/gate/gate.js";
import type { ChatMessage, LLMResult, Llm } from "../src/llm/chat.js";
import { JsonStore } from "../src/store.js";
import { ToolRegistry, defineTool } from "../src/tools/registry.js";

const tools = new ToolRegistry(new ApprovalGate(new JsonStore())).add(
  defineTool({ name: "lookup", description: "Look something up.", schema: z.object({ q: z.string() }), run: ({ q }) => `found ${q}` }),
);

const toolCall = (id: string, q: string): LLMResult => ({
  type: "tool_calls",
  calls: [{ id, name: "lookup", args: { q } }],
  rawMessage: { role: "assistant", tool_calls: [{ id, type: "function", function: { name: "lookup", arguments: JSON.stringify({ q }) } }] },
});

/** A fake model that plays a script and records what it was sent. */
function scripted(...steps: LLMResult[]) {
  const sent: ChatMessage[][] = [];
  const llm: Llm = async (messages) => {
    sent.push(structuredClone(messages));
    return steps.shift() ?? toolCall(`c${sent.length}`, "again");
  };
  return { llm, sent };
}

describe("agent loop", () => {
  it("answers directly when no tool is needed", async () => {
    const { llm } = scripted({ type: "text", content: "Hello." });
    const r = await runAgent({ llm, tools, maxIterations: 5 }, [], "hi");
    expect(r).toMatchObject({ reply: "Hello.", iterations: 0 });
  });

  it("runs the tool and hands the result back to the model", async () => {
    const { llm, sent } = scripted(toolCall("c1", "L-001"), { type: "text", content: "L-001 is due." });
    const r = await runAgent({ llm, tools, maxIterations: 5 }, [], "what about L-001?");
    expect(r.reply).toBe("L-001 is due.");
    expect(sent[1]!.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "found L-001" });
  });

  it("warns the model as the budget runs down and ends with what it found", async () => {
    const { llm, sent } = scripted();
    const r = await runAgent({ llm, tools, maxIterations: 4 }, [], "loop forever");
    expect(r.iterations).toBe(4);
    expect(r.reply).toContain("step limit (4)");
    expect(r.reply).toContain("[lookup] found again");
    const warnings = sent.flat().filter((m) => m.role === "user" && String(m.content).startsWith("[SYSTEM"));
    expect(warnings.map((m) => String(m.content).slice(9, 13))).toContain("Note");
  });

  it("raises the pressure at 50, 75 and 90 percent", () => {
    expect(budgetPressure(4, 10)).toBeNull();
    expect(budgetPressure(5, 10)).toMatch(/^Note/);
    expect(budgetPressure(8, 10)).toMatch(/^WARNING/);
    expect(budgetPressure(9, 10)).toMatch(/^CRITICAL/);
  });
});
