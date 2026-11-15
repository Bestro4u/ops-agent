/**
 * Provider auto-switch, run on every watchdog sweep.
 *
 * Why it exists: in October 2026 the production bot's saved provider started
 * answering a one-line ping in 15 to 20 seconds, or not at all. Every reply
 * waited on it before the per-call fallback kicked in, and nothing moved the
 * saved choice off a provider that had stopped working.
 *
 * Now each sweep pings the active provider. If it errors, times out or is
 * slower than SLOW_MS, the others are pinged and the agent switches to the
 * first healthy one, remembering where it came from ("home"). Once home answers
 * fast on HOME_OK_SWEEPS sweeps in a row, it switches back. A person's manual
 * choice clears that memory, so a human decision always wins.
 */
import type { JsonStore } from "../store.js";
import type { Failover } from "./failover.js";
import { PROVIDER_IDS, isProviderId, type ProviderId, type Providers } from "./providers.js";

export const PROBE_TIMEOUT_MS = 20_000;
/** A healthy model answers a one-line ping in 1 to 3 seconds. Over 10, something upstream is struggling. */
export const SLOW_MS = 10_000;
export const HOME_OK_SWEEPS = 2;

const HOME_KEY = "llm.autoswitch.home";
const HOME_OK_KEY = "llm.autoswitch.homeOk";

export interface ProbeResult {
  id: ProviderId;
  healthy: boolean;
  /** One line for logs and alerts. Never contains a key. */
  detail: string;
}

export type Probe = (id: ProviderId, model: string) => Promise<ProbeResult>;

/** Ping a provider over HTTP and judge the answer: it came, it has text, it was fast. */
export function httpProbe(providers: Providers, fetchFn: typeof fetch = fetch): Probe {
  return async (id, model) => {
    const spec = providers.spec(id);
    if (!spec.apiKey) return { id, healthy: false, detail: `${spec.label}: no API key` };
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetchFn(`${spec.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${spec.apiKey}`, "Content-Type": "application/json" },
        // 32 tokens, not 1: thinking models spend a 1-token budget on reasoning and return no text.
        body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: "user", content: "ping" }] }),
      });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (!res.ok) return { id, healthy: false, detail: `${spec.label}: HTTP ${res.status} on ${model}` };
      const json = (await res.json().catch(() => null)) as { choices?: unknown[] } | null;
      if (!json?.choices?.length) return { id, healthy: false, detail: `${spec.label}: empty answer on ${model}` };
      if (Date.now() - started > SLOW_MS) return { id, healthy: false, detail: `${spec.label}: took ${secs}s on ${model}, too slow` };
      return { id, healthy: true, detail: `${spec.label}: answered in ${secs}s (${model})` };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        id,
        healthy: false,
        detail: aborted ? `${spec.label}: no answer within ${PROBE_TIMEOUT_MS / 1000}s` : `${spec.label}: ${(err as Error).message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface LlmHealth {
  ok: boolean;
  detail: string;
  /** A plain message for the owner when the provider changed. */
  notice?: string;
}

export class AutoSwitch {
  constructor(
    private readonly providers: Providers,
    private readonly failover: Failover,
    private readonly probe: Probe,
    private readonly store: JsonStore,
    private readonly order: ProviderId[] = PROVIDER_IDS,
  ) {}

  /** The provider the agent moved away from and will return to, if any. */
  home(): ProviderId | null {
    const v = this.store.get<string>(HOME_KEY);
    return v && isProviderId(v) ? v : null;
  }

  /** Forget the auto-switch. Call this when a person picks a provider. */
  clear(): void {
    this.store.set(HOME_KEY, undefined);
    this.store.set(HOME_OK_KEY, 0);
  }

  async check(): Promise<LlmHealth> {
    const activeId = this.providers.activeId();
    const active = await this.probe(activeId, this.failover.activeModel());

    if (active.healthy) {
      const notice = await this.trySwitchBack(activeId);
      return { ok: true, detail: active.detail, notice };
    }

    const tried = [active.detail];
    for (const id of this.order) {
      if (id === activeId || !this.providers.isConfigured(id)) continue;
      const probe = await this.probe(id, this.providers.spec(id).chain[0]!);
      tried.push(probe.detail);
      if (!probe.healthy || this.failover.switchProvider(id)) continue;

      const home = this.home() ?? activeId;
      if (id === home) {
        this.clear();
      } else {
        this.store.set(HOME_KEY, home);
        this.store.set(HOME_OK_KEY, 0);
      }
      const label = this.providers.spec(id).label;
      const back =
        id === home ? "" : ` I'll move back to ${this.providers.spec(home).label} once it answers fast on ${HOME_OK_SWEEPS} checks in a row.`;
      return {
        ok: true,
        detail: `switched to ${label}`,
        notice: `AI model switched. ${active.detail}. Replies now run on ${label}.${back}`,
      };
    }
    return { ok: false, detail: tried.join("; ") };
  }

  private async trySwitchBack(activeId: ProviderId): Promise<string | undefined> {
    const home = this.home();
    if (!home) return undefined;
    if (home === activeId || !this.providers.isConfigured(home)) {
      this.clear();
      return undefined;
    }
    const probe = await this.probe(home, this.providers.spec(home).chain[0]!);
    const streak = probe.healthy ? (this.store.get<number>(HOME_OK_KEY) ?? 0) + 1 : 0;
    if (streak < HOME_OK_SWEEPS) {
      this.store.set(HOME_OK_KEY, streak);
      return undefined;
    }
    if (this.failover.switchProvider(home)) return undefined;
    this.clear();
    return `${this.providers.spec(home).label} is answering again, so I moved the AI model back to it.`;
  }
}
