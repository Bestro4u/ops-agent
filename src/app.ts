/**
 * Wires the pieces together. Both entry points (Telegram and the terminal)
 * build the same app, so what you try locally is what runs in the bot.
 */
import { runAgent } from "./agent/loop.js";
import { loadEnv, type Env } from "./config.js";
import { Crm } from "./crm/crm.js";
import { ApprovalGate } from "./gate/gate.js";
import { AutoSwitch, httpProbe, type Probe } from "./llm/autoswitch.js";
import { createLlm, type ChatMessage, type Llm } from "./llm/chat.js";
import { Failover } from "./llm/failover.js";
import { Providers, providerSpecs } from "./llm/providers.js";
import { JsonStore } from "./store.js";
import { crmTools } from "./tools/crm.js";
import { ToolRegistry } from "./tools/registry.js";
import type { Check } from "./watchdog/watchdog.js";

export const SYSTEM_PROMPT = [
  "You are an operations assistant for a small outbound sales team. You work on the team's CRM through your tools.",
  "Use tools for facts. Never invent leads, dates or results.",
  "Touches can only be logged inside the lead's working hours. If a tool says Locked, tell the user when the window opens.",
  "Deleting a lead, or changing more than 10 leads at once, needs the owner's approval. When a tool answers QUEUED FOR APPROVAL, say it is waiting for approval. Never say it is done.",
  "Keep replies short and plain.",
].join("\n");

const HISTORY_LIMIT = 20;

export interface App {
  env: Env;
  store: JsonStore;
  providers: Providers;
  failover: Failover;
  autoswitch: AutoSwitch;
  gate: ApprovalGate;
  tools: ToolRegistry;
  crm: Crm;
  checks: Check[];
  ask(chatId: number, text: string): Promise<string>;
  reset(chatId: number): void;
}

export interface AppOverrides {
  store?: JsonStore;
  llm?: Llm;
  probe?: Probe;
  now?: () => Date;
}

export function createApp(env: Env = loadEnv(), overrides: AppOverrides = {}): App {
  const store = overrides.store ?? new JsonStore(env.STATE_FILE);
  const providers = new Providers(providerSpecs(env), store, env.LLM_PROVIDER);
  if (!overrides.llm && providers.configured().length === 0) {
    throw new Error("No model key set. Add GEMINI_API_KEY (the free tier works), OPENROUTER_API_KEY or OPENAI_API_KEY to .env.");
  }
  const failover = new Failover(providers);
  const autoswitch = new AutoSwitch(providers, failover, overrides.probe ?? httpProbe(providers), store);
  const gate = new ApprovalGate(store);
  const now = overrides.now ?? (() => new Date());
  const crm = new Crm(store, now());
  const tools = new ToolRegistry(gate).add(...crmTools(crm, now));
  const llm = overrides.llm ?? createLlm(providers, failover, SYSTEM_PROMPT);
  const histories = new Map<number, ChatMessage[]>();

  async function ask(chatId: number, text: string): Promise<string> {
    const history = histories.get(chatId) ?? [];
    let reply: string;
    try {
      reply = (await runAgent({ llm, tools, maxIterations: env.MAX_ITERATIONS }, history, text)).reply;
    } catch (err) {
      reply = `I couldn't reach an AI model just now (${(err as Error).message}). The watchdog switches provider as soon as one answers.`;
    }
    const next: ChatMessage[] = [...history, { role: "user", content: text }, { role: "assistant", content: reply }];
    histories.set(chatId, next.slice(-HISTORY_LIMIT));
    return reply;
  }

  const checks: Check[] = [
    async () => {
      const health = await autoswitch.check();
      return {
        name: "AI model",
        ok: health.ok,
        detail: health.detail,
        notice: health.notice,
        mitigate: async () => (failover.reset() ? "moved back to the first model in the chain" : null),
      };
    },
    async () => {
      try {
        store.set("watchdog.lastSweep", new Date().toISOString());
        return { name: "State file", ok: true, detail: "writable" };
      } catch (err) {
        return { name: "State file", ok: false, detail: (err as Error).message };
      }
    },
    async () => {
      const mb = process.memoryUsage().rss / 1_048_576;
      return { name: "Memory", ok: mb < 512, detail: `${mb.toFixed(0)} MB in use` };
    },
  ];

  return { env, store, providers, failover, autoswitch, gate, tools, crm, checks, ask, reset: (id) => histories.delete(id) };
}
