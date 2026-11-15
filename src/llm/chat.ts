import type OpenAI from "openai";
import type { Failover } from "./failover.js";
import type { Providers } from "./providers.js";

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
export type ToolDefinition = OpenAI.Chat.ChatCompletionTool;

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type LLMResult =
  | { type: "text"; content: string }
  | { type: "tool_calls"; calls: ToolCall[]; rawMessage: OpenAI.Chat.ChatCompletionAssistantMessageParam };

/** The one function the agent loop needs. Tests pass a fake. */
export type Llm = (messages: ChatMessage[], tools: ToolDefinition[]) => Promise<LLMResult>;

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Models sometimes send broken JSON. Pass it on so the tool returns a clear error the model can fix.
    return { _unparsed_arguments: raw };
  }
}

export function createLlm(providers: Providers, failover: Failover, systemPrompt: string): Llm {
  return async (messages, tools) => {
    const response = await failover.run((model) =>
      providers.client().chat.completions.create({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        tools,
        tool_choice: "auto",
      }),
    );
    const msg = response.choices[0]?.message;
    if (!msg) return { type: "text", content: "" };
    if (msg.tool_calls?.length) {
      return {
        type: "tool_calls",
        calls: msg.tool_calls.map((tc) => ({ id: tc.id, name: tc.function.name, args: parseArgs(tc.function.arguments) })),
        rawMessage: msg as OpenAI.Chat.ChatCompletionAssistantMessageParam,
      };
    }
    return { type: "text", content: msg.content ?? "" };
  };
}
