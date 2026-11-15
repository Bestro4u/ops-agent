/**
 * Tools the model can call. Each one declares its input with a zod schema,
 * which gives the model a JSON Schema and gives the code a validator, from one
 * definition. Bad input goes back to the model as a plain error it can fix,
 * never as a crash.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ApprovalGate } from "../gate/gate.js";
import type { ToolDefinition } from "../llm/chat.js";

export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  /** true: always needs approval. A function: needs approval for these arguments only (for example, bulk edits over 10). */
  gate?: boolean | ((args: z.infer<S>) => boolean);
  /** The line the approval card shows. */
  summarize?: (args: z.infer<S>) => string;
  run: (args: z.infer<S>) => Promise<string> | string;
}

export function defineTool<S extends z.ZodTypeAny>(tool: Tool<S>): Tool<S> {
  return tool;
}

/** Some providers reject JSON Schema keys they don't use, so keep only what function calling needs. */
function cleanSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([k]) => k !== "$schema" && k !== "additionalProperties")
      .map(([k, v]) => [k, cleanSchema(v)]),
  );
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(private readonly gate: ApprovalGate) {}

  add(...tools: Tool<any>[]): this {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
      // The gate runs the real action after approval, re-validating the saved arguments.
      this.gate.register(tool.name, async (args) => String(await tool.run(tool.schema.parse(args))));
    }
    return this;
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: cleanSchema(zodToJsonSchema(t.schema, { $refStrategy: "none" })) as Record<string, unknown>,
      },
    }));
  }

  async execute(name: string, rawArgs: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `Unknown tool "${name}". Use one of: ${[...this.tools.keys()].join(", ")}.`;

    const parsed = tool.schema.safeParse(rawArgs);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
      return `Invalid arguments for ${name}: ${issues}. Fix them and call again.`;
    }

    const needsApproval = typeof tool.gate === "function" ? tool.gate(parsed.data) : Boolean(tool.gate);
    if (needsApproval) {
      const summary = tool.summarize?.(parsed.data) ?? `${name} ${JSON.stringify(parsed.data)}`;
      return this.gate.queue(name, summary, parsed.data as Record<string, unknown>);
    }

    try {
      return String(await tool.run(parsed.data));
    } catch (err) {
      return `${name} failed: ${(err as Error).message}`;
    }
  }
}
