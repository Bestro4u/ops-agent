/**
 * CRM tools for the agent. The rules live in code, not in the prompt:
 * - log_touch refuses outside the lead's working hours and holidays.
 * - delete_lead always needs the owner's approval.
 * - bulk_update_status needs approval when it touches more than 10 leads.
 */
import { z } from "zod";
import { CHANNELS, STATUSES, type Crm, type Lead } from "../crm/crm.js";
import { describeWindow, isDue, sendWindow, zonedParts } from "../crm/worktime.js";
import { defineTool, type Tool } from "./registry.js";

export const BULK_APPROVAL_OVER = 10;

const leadId = z.string().regex(/^L-\d{3}$/i, "lead ids look like L-001");

const dueLabel = (lead: Lead) => {
  if (!lead.nextActionDate) return "no next touch";
  const d = new Date(lead.nextActionDate);
  return new Intl.DateTimeFormat("en-GB", { timeZone: lead.timezone, weekday: "short", day: "numeric", month: "short" }).format(d);
};

export function crmTools(crm: Crm, now: () => Date = () => new Date()): Tool<any>[] {
  const line = (lead: Lead) => {
    const w = describeWindow(sendWindow(crm.rules(lead), now(), crm.holidays()), now());
    return `${lead.id} ${lead.company} (${lead.contact}): ${lead.status}, touch ${lead.touchCount}, ${w}`;
  };

  return [
    defineTool({
      name: "today_queue",
      description: "List the leads due a touch today (or overdue), each with whether its working hours are open now.",
      schema: z.object({}),
      run: () => {
        const due = crm
          .leads()
          .filter((l) => !["won", "lost", "replied"].includes(l.status) && isDue(l.nextActionDate, l.timezone, now()))
          .sort((a, b) => (a.nextActionDate ?? "").localeCompare(b.nextActionDate ?? ""));
        return due.length ? `${due.length} due:\n${due.map(line).join("\n")}` : "Nothing is due today.";
      },
    }),

    defineTool({
      name: "get_lead",
      description: "Get one lead's details, touch history and notes.",
      schema: z.object({ id: leadId }),
      run: ({ id }) => {
        const lead = crm.lead(id);
        if (!lead) return `No lead ${id}.`;
        const touches = crm.touches(lead.id).map((t) => `touch ${t.touchNumber} by ${t.channel} at ${t.at}${t.note ? `: ${t.note}` : ""}`);
        return [
          line(lead),
          `Email: ${lead.email}. Time zone: ${lead.timezone}. Next touch: ${dueLabel(lead)}.`,
          touches.length ? `History:\n${touches.join("\n")}` : "No touches logged yet.",
          lead.notes.length ? `Notes:\n${lead.notes.join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    }),

    defineTool({
      name: "log_touch",
      description: "Record that a message went out to a lead and schedule the next touch. Refused outside the lead's working hours.",
      schema: z.object({ id: leadId, channel: z.enum(CHANNELS), note: z.string().max(500).optional() }),
      run: ({ id, channel, note }) => {
        const lead = crm.lead(id);
        if (!lead) return `No lead ${id}.`;
        if (["won", "lost"].includes(lead.status)) return `${lead.company} is ${lead.status}. Nothing was logged.`;
        const window = sendWindow(crm.rules(lead), now(), crm.holidays());
        if (!window.open) {
          return `Locked: ${lead.company} is outside working hours (${window.reason}). ${describeWindow(window, now())}. Nothing was logged.`;
        }
        const touchNumber = lead.touchCount + 1;
        const next = crm.nextActionAfter(lead, touchNumber, now());
        crm.addTouch({ leadId: lead.id, touchNumber, channel, note, at: now().toISOString() });
        crm.saveLead({ ...lead, touchCount: touchNumber, status: lead.status === "new" ? "contacted" : lead.status, nextActionDate: next });
        const updated = crm.lead(lead.id)!;
        return `Logged touch ${touchNumber} to ${lead.company} by ${channel}. ${next ? `Next touch: ${dueLabel(updated)}.` : "That was the last touch in the sequence."}`;
      },
    }),

    defineTool({
      name: "update_status",
      description: "Change one lead's status, with an optional note.",
      schema: z.object({ id: leadId, status: z.enum(STATUSES), note: z.string().max(500).optional() }),
      run: ({ id, status, note }) => {
        const lead = crm.lead(id);
        if (!lead) return `No lead ${id}.`;
        const stamp = zonedParts(now(), lead.timezone).day;
        crm.saveLead({ ...lead, status, notes: note ? [...lead.notes, `${stamp}: ${note}`] : lead.notes });
        return `${lead.company} is now ${status}.`;
      },
    }),

    defineTool({
      name: "delete_lead",
      description: "Delete a lead and its history. Always needs the owner's approval.",
      schema: z.object({ id: leadId, reason: z.string().min(3) }),
      gate: true,
      summarize: ({ id, reason }) => `Delete ${id} (${crm.lead(id)?.company ?? "unknown"}) and its history. Reason: ${reason}`,
      run: ({ id }) => (crm.deleteLead(id) ? `Deleted ${id}.` : `No lead ${id}, nothing deleted.`),
    }),

    defineTool({
      name: "bulk_update_status",
      description: `Set the same status on several leads. More than ${BULK_APPROVAL_OVER} leads at once needs the owner's approval.`,
      schema: z.object({ ids: z.array(leadId).min(1).max(200), status: z.enum(STATUSES) }),
      gate: ({ ids }) => ids.length > BULK_APPROVAL_OVER,
      summarize: ({ ids, status }) => `Set ${ids.length} leads to "${status}": ${ids.join(", ")}`,
      run: ({ ids, status }) => {
        const changed: string[] = [];
        const missing: string[] = [];
        for (const id of ids) {
          const lead = crm.lead(id);
          if (!lead) missing.push(id);
          else {
            crm.saveLead({ ...lead, status });
            changed.push(lead.id);
          }
        }
        return `Set ${changed.length} to ${status}.${missing.length ? ` Not found: ${missing.join(", ")}.` : ""}`;
      },
    }),

    defineTool({
      name: "current_time",
      description: "The current date and time in Lagos, London, New York and Chicago.",
      schema: z.object({}),
      run: () =>
        ["Africa/Lagos", "Europe/London", "America/New_York", "America/Chicago"]
          .map((tz) => `${tz}: ${new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(now())}`)
          .join("\n"),
    }),
  ];
}
