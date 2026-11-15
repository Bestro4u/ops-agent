import type OpenAI from "openai";
import { Providers, providerSpecs, type ProviderId } from "../src/llm/providers.js";
import { JsonStore } from "../src/store.js";

export const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

/** Providers with fake keys, an in-memory store and no real network clients. */
export function makeProviders(keys: ProviderId[], preferred?: ProviderId) {
  const store = new JsonStore();
  const env = {
    GEMINI_API_KEY: keys.includes("gemini") ? "test-g" : undefined,
    OPENROUTER_API_KEY: keys.includes("openrouter") ? "test-o" : undefined,
    OPENAI_API_KEY: keys.includes("openai") ? "test-a" : undefined,
  };
  const providers = new Providers(providerSpecs(env), store, preferred, () => ({}) as OpenAI);
  return { providers, store };
}
