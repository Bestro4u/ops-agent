/**
 * Self-healing watchdog: check, fix, and only then tell a person.
 *
 * Alert policy, learned the hard way: the first version messaged on every
 * failed check and again on every recovery, so one slow ping that healed itself
 * produced two messages, several times a day. People stop reading alerts like
 * that. Now:
 *
 *   1st failure  -> run the safe automatic fix, log it, say nothing
 *   2nd failure  -> one message: the fix did not hold
 *   3rd failure  -> one escalation, then automatic retries pause
 *   later        -> silent until the check passes again
 *   recovery     -> "working again", but only if the person was told it was down
 */
import type { JsonStore } from "../store.js";

export const ESCALATE_AFTER = 3;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** A safe automatic fix. Returns what it did, or null if there was nothing to do. */
  mitigate?: () => Promise<string | null>;
  /** Sent as is, pass or fail (for example: "AI model switched to OpenRouter"). */
  notice?: string;
}

export type Check = () => Promise<CheckResult>;

export interface SweepReport {
  passed: string[];
  failing: string[];
  fixes: string[];
  alerts: string[];
}

const FAILS_KEY = "watchdog.fails";

export class Watchdog {
  constructor(
    private readonly store: JsonStore,
    private readonly alert: (text: string) => Promise<void>,
    private readonly checks: Check[],
  ) {}

  async sweep(): Promise<SweepReport> {
    const report: SweepReport = { passed: [], failing: [], fixes: [], alerts: [] };
    const say = async (text: string) => {
      report.alerts.push(text);
      await this.alert(text).catch(() => {});
    };

    const results = await Promise.all(
      this.checks.map((check) =>
        check().catch((err: Error): CheckResult => ({ name: "watchdog", ok: false, detail: `a check crashed: ${err.message}` })),
      ),
    );

    for (const r of results) {
      const prev = this.fails(r.name);
      if (r.notice) await say(r.notice);

      if (r.ok) {
        report.passed.push(r.name);
        if (prev > 0) this.setFails(r.name, 0);
        if (prev >= 2) await say(`${r.name} is working again.`);
        continue;
      }

      report.failing.push(r.name);
      const fails = prev + 1;
      this.setFails(r.name, fails);

      if (r.mitigate && fails <= ESCALATE_AFTER) {
        const did = await r.mitigate().catch(() => null);
        if (did) report.fixes.push(`${r.name}: ${did}`);
      }

      if (fails === 2) {
        await say(`${r.name} is still failing after an automatic fix (${r.detail}). I'll keep trying and tell you if it stays down.`);
      } else if (fails === ESCALATE_AFTER) {
        await say(`${r.name} has failed ${fails} checks in a row (${r.detail}). Automatic retries are paused until it recovers.`);
      }
    }
    return report;
  }

  private fails(name: string): number {
    return this.store.get<Record<string, number>>(FAILS_KEY)?.[name] ?? 0;
  }

  private setFails(name: string, n: number): void {
    this.store.update<Record<string, number>>(FAILS_KEY, {}, (all) => ({ ...all, [name]: n }));
  }
}
