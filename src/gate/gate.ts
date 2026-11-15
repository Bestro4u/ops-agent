/**
 * Approval gate for tools that change things.
 *
 * Why it is code, not a prompt: in the production bot, the only thing that
 * once stopped the agent from sending, publishing or changing records was a
 * line in its system prompt. A prompt can be argued with. Now a gated tool never runs
 * its action directly. It calls queue(), which saves a pending request and
 * sends the owner an Approve / Reject card. The action runs only from that
 * button, so no wording of a message can make the model execute it.
 *
 *   tool call -> queue() -> pending record + approval card
 *   Approve   -> resolve(id, "ok") -> handler runs once -> result posted
 *   Reject    -> resolve(id, "no") -> nothing runs
 */
import { randomBytes } from "node:crypto";
import type { JsonStore } from "../store.js";

/** An approval tapped after this long is refused: the context has gone stale. */
export const ACTION_TTL_MS = 24 * 60 * 60_000;

export type ActionHandler = (args: Record<string, unknown>) => Promise<string>;
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalRecord {
  id: string;
  tool: string;
  summary: string;
  args: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
}

/** How a pending request reaches a person: a Telegram card, a terminal prompt, a test spy. */
export interface Notifier {
  requestApproval(record: ApprovalRecord): Promise<void>;
}

const STORE_KEY = "approvals";

export class ApprovalGate {
  private readonly handlers = new Map<string, ActionHandler>();
  private notifier: Notifier | null = null;

  constructor(
    private readonly store: JsonStore,
    private readonly now: () => number = Date.now,
  ) {}

  setNotifier(notifier: Notifier): void {
    this.notifier = notifier;
  }

  /** Register the function that performs a gated tool's real action. */
  register(tool: string, handler: ActionHandler): void {
    this.handlers.set(tool, handler);
  }

  /** Queue an action. Returns the text the tool hands back to the model. */
  async queue(tool: string, summary: string, args: Record<string, unknown>): Promise<string> {
    if (!this.handlers.has(tool)) return `Gate error: no handler registered for ${tool}. Nothing was done.`;
    if (!this.notifier) return `Gate error: no way to ask for approval right now, so ${tool} cannot run. Nothing was done.`;

    const record: ApprovalRecord = {
      id: randomBytes(5).toString("hex"),
      tool,
      summary,
      args,
      status: "pending",
      createdAt: this.now(),
      expiresAt: this.now() + ACTION_TTL_MS,
    };
    this.save(record);
    try {
      await this.notifier.requestApproval(record);
    } catch (err) {
      this.save({ ...record, status: "rejected" });
      return `Could not send the approval request (${(err as Error).message}). Nothing was done.`;
    }
    return `QUEUED FOR APPROVAL (id ${record.id}). Nothing has happened yet: ${tool} runs only if the owner taps Approve. Say that plainly; do not say it is done.`;
  }

  async resolve(id: string, decision: "ok" | "no"): Promise<{ text: string; ran: boolean }> {
    const record = this.find(id);
    if (!record) return { text: "That approval no longer exists.", ran: false };
    if (record.status !== "pending") return { text: `Already ${record.status}. Nothing more to do.`, ran: false };

    if (decision === "no") {
      this.save({ ...record, status: "rejected" });
      return { text: `Rejected. ${record.tool} did not run.`, ran: false };
    }
    if (record.expiresAt < this.now()) {
      this.save({ ...record, status: "rejected" });
      return { text: `Expired (older than 24 hours). ${record.tool} did not run. Ask again if you still want it.`, ran: false };
    }
    const handler = this.handlers.get(record.tool);
    if (!handler) return { text: `No handler for ${record.tool}. Nothing ran.`, ran: false };

    // Mark approved before running, so a double tap cannot run the action twice.
    this.save({ ...record, status: "approved" });
    try {
      return { text: await handler(record.args), ran: true };
    } catch (err) {
      return { text: `Approved, but ${record.tool} failed: ${(err as Error).message}`, ran: true };
    }
  }

  pending(): ApprovalRecord[] {
    return this.all().filter((r) => r.status === "pending");
  }

  private all(): ApprovalRecord[] {
    return Object.values(this.store.get<Record<string, ApprovalRecord>>(STORE_KEY) ?? {});
  }

  private find(id: string): ApprovalRecord | undefined {
    return this.store.get<Record<string, ApprovalRecord>>(STORE_KEY)?.[id];
  }

  private save(record: ApprovalRecord): void {
    this.store.update<Record<string, ApprovalRecord>>(STORE_KEY, {}, (all) => ({ ...all, [record.id]: record }));
  }
}
