/**
 * Model providers behind one OpenAI-compatible interface.
 *
 * Every chat call, the watchdog's probe and a runtime /provider switch go
 * through this class, so switching provider moves everything together instead
 * of leaving half the agent pointed at the old endpoint. The choice is saved in
 * the store, so it survives a restart.
 */
import OpenAI from "openai";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "../config.js";
import type { JsonStore } from "../store.js";

export type ProviderId = "gemini" | "openrouter" | "openai";
export const PROVIDER_IDS: ProviderId[] = ["gemini", "openrouter", "openai"];

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  baseUrl: string;
  apiKey: string | undefined;
  /** Models to try in order. The first is the normal one; the rest take over on rate limits and outages. */
  chain: string[];
}

export function providerSpecs(env: Partial<Env>): Record<ProviderId, ProviderSpec> {
  return {
    gemini: {
      id: "gemini",
      label: "Google Gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: env.GEMINI_API_KEY,
      chain: env.GEMINI_MODELS ?? ["gemini-2.5-flash", "gemini-2.5-pro"],
    },
    openrouter: {
      id: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: env.OPENROUTER_API_KEY,
      chain: env.OPENROUTER_MODELS ?? ["deepseek/deepseek-chat", "google/gemini-2.5-flash"],
    },
    openai: {
      id: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      chain: env.OPENAI_MODELS ?? ["gpt-4.1-mini", "gpt-4.1"],
    },
  };
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as string[]).includes(value);
}

const STORE_KEY = "llm.provider";

export type ClientFactory = (spec: ProviderSpec) => OpenAI;

const defaultFactory: ClientFactory = (spec) =>
  // A placeholder key lets a half-configured setup boot: the client throws on an
  // empty key, while a wrong key only surfaces as a 401 that failover handles.
  new OpenAI({ baseURL: spec.baseUrl, apiKey: spec.apiKey ?? "not-set" });

export class Providers {
  private readonly clients = new Map<ProviderId, OpenAI>();
  /**
   * Per-call override used by the cross-provider retry in failover.ts. It is
   * scoped to one async call chain, so it never changes the saved choice or
   * other requests running at the same time.
   */
  private readonly perCall = new AsyncLocalStorage<ProviderId>();

  constructor(
    private readonly specs: Record<ProviderId, ProviderSpec>,
    private readonly store: JsonStore,
    private readonly preferred?: ProviderId,
    private readonly makeClient: ClientFactory = defaultFactory,
  ) {}

  spec(id: ProviderId = this.activeId()): ProviderSpec {
    return this.specs[id];
  }

  isConfigured(id: ProviderId): boolean {
    return Boolean(this.specs[id].apiKey);
  }

  configured(): ProviderId[] {
    return PROVIDER_IDS.filter((id) => this.isConfigured(id));
  }

  /** Saved choice first, then LLM_PROVIDER, then the first provider with a key. */
  activeId(): ProviderId {
    const saved = this.store.get<string>(STORE_KEY);
    if (saved && isProviderId(saved) && this.isConfigured(saved)) return saved;
    if (this.preferred && this.isConfigured(this.preferred)) return this.preferred;
    return this.configured()[0] ?? "gemini";
  }

  /** Returns an error message instead of switching to a provider with no key. */
  setActive(id: ProviderId): string | null {
    if (!this.isConfigured(id)) return `${this.specs[id].label} has no API key set.`;
    this.store.set(STORE_KEY, id);
    return null;
  }

  runWith<T>(id: ProviderId, fn: () => Promise<T>): Promise<T> {
    return this.perCall.run(id, fn);
  }

  /** The provider serving the current call: the per-call override, else the active one. */
  callId(): ProviderId {
    return this.perCall.getStore() ?? this.activeId();
  }

  client(id: ProviderId = this.callId()): OpenAI {
    let client = this.clients.get(id);
    if (!client) {
      client = this.makeClient(this.specs[id]);
      this.clients.set(id, client);
    }
    return client;
  }
}
