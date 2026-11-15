/**
 * The agent loop: ask the model, run the tools it asks for, feed the results
 * back, repeat until it answers in text or the iteration budget runs out.
 *
 * Two guards keep it from wandering:
 * - Budget pressure. At 50%, 75% and 90% of the budget the model is told how
 *   many turns are left, so it wraps up instead of being cut off mid-task.
 * - A useful ending. If the budget runs out, the reply lists what the tools
 *   found, instead of a bare "limit reached".
 */
import type { ChatMessage, Llm } from "../llm/chat.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface AgentDeps {
  llm: Llm;
  tools: ToolRegistry;
  maxIterations: number;
}

export interface AgentResult {
  reply: string;
  /** One line per tool call, for logs and the final fallback. */
  toolLog: string[];
  iterations: number;
}

export function budgetPressure(used: number, max: number): string | null {
  const pct = used / max;
  if (pct >= 0.9) return `CRITICAL: ${used}/${max} steps used. Give your final answer now. Call no more tools unless essential.`;
  if (pct >= 0.75) return `WARNING: ${used}/${max} steps used, ${max - used} left. Wrap up with what you have.`;
  if (pct >= 0.5) return `Note: ${used}/${max} steps used. Skip tool calls you don't need.`;
  return null;
}

export async function runAgent(deps: AgentDeps, history: ChatMessage[], userMessage: string): Promise<AgentResult> {
  const messages: ChatMessage[] = [...history, { role: "user", content: userMessage }];
  const toolLog: string[] = [];
  let iterations = 0;

  while (iterations < deps.maxIterations) {
    const result = await deps.llm(messages, deps.tools.definitions());
    if (result.type === "text") return { reply: result.content, toolLog, iterations };

    iterations += 1;
    messages.push(result.rawMessage);

    // Independent tool calls from one model turn run in parallel.
    const outputs = await Promise.all(
      result.calls.map(async (call) => ({ call, output: await deps.tools.execute(call.name, call.args) })),
    );
    for (const { call, output } of outputs) {
      toolLog.push(`[${call.name}] ${output.slice(0, 300)}${output.length > 300 ? "..." : ""}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }

    const pressure = budgetPressure(iterations, deps.maxIterations);
    if (pressure) messages.push({ role: "user", content: `[SYSTEM: ${pressure}]` });
  }

  const found = toolLog.length
    ? `\n\nWhat I found before stopping:\n${toolLog.slice(-5).map((l) => `- ${l}`).join("\n")}`
    : "";
  return {
    reply: `I hit the step limit (${deps.maxIterations}) before finishing.${found}\n\nAsk for one part of this and I'll pick it up.`,
    toolLog,
    iterations,
  };
}
