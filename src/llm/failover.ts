/**
 * Two layers of failover for every model call.
 *
 * 1. Inside a provider: on 429, 500, 502 or 503 the next model in the chain is
 *    tried. The position sticks until reset() (the watchdog calls it), so one
 *    rate limit doesn't make every later call fail first.
 * 2. Across providers: if the active provider fails outright (expired plan,
 *    bad key, outage), the same call is retried once on the next provider that
 *    has a key. The saved choice does not change, so the watchdog still sees
 *    and reports the broken provider.
 *
 * Why layer 2 exists: in September 2026 the production bot's main provider
 * failed twice (once a lapsed plan, once a changed API requirement) and
 * nothing moved the bot off it. Replies were down until a person noticed.
 */
import { PROVIDER_IDS, type ProviderId, type Providers } from "./providers.js";

export const RETRY_STATUSES = new Set([429, 500, 502, 503]);

export function statusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  const s = e?.status ?? e?.statusCode;
  return typeof s === "number" ? s : undefined;
}

const isRetriable = (err: unknown) => {
  const s = statusOf(err);
  return s !== undefined && RETRY_STATUSES.has(s);
};

export class Failover {
  private index = 0;

  constructor(private readonly providers: Providers) {}

  activeModel(): string {
    const chain = this.providers.spec().chain;
    return chain[this.index] ?? chain[0]!;
  }

  /** Back to the first model in the chain. Returns true if it had moved. */
  reset(): boolean {
    const moved = this.index !== 0;
    this.index = 0;
    return moved;
  }

  /** Switch provider and start its chain from the top. */
  switchProvider(id: ProviderId): string | null {
    const err = this.providers.setActive(id);
    if (!err) this.index = 0;
    return err;
  }

  async run<T>(fn: (model: string) => Promise<T>): Promise<T> {
    try {
      return await this.runActiveChain(fn);
    } catch (err) {
      const active = this.providers.activeId();
      const fallback = PROVIDER_IDS.find((id) => id !== active && this.providers.isConfigured(id));
      if (!fallback) throw err;
      return this.providers.runWith(fallback, () => runChain(fn, this.providers.spec(fallback).chain, err));
    }
  }

  private async runActiveChain<T>(fn: (model: string) => Promise<T>): Promise<T> {
    const start = this.index;
    const last = this.providers.spec().chain.length - 1;
    for (;;) {
      const model = this.activeModel();
      try {
        return await fn(model);
      } catch (err) {
        if (isRetriable(err) && this.index < last) {
          this.index += 1;
          continue;
        }
        this.index = start;
        throw err;
      }
    }
  }
}

/** Try a fixed chain in order without touching the active chain's position. */
async function runChain<T>(fn: (model: string) => Promise<T>, chain: string[], originalErr: unknown): Promise<T> {
  let lastErr = originalErr;
  for (const model of chain) {
    try {
      return await fn(model);
    } catch (err) {
      lastErr = err;
      if (!isRetriable(err)) break;
    }
  }
  throw lastErr;
}
