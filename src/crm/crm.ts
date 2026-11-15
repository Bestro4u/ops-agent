/**
 * A small demo CRM, so the agent has something real to act on.
 *
 * The production bot works on a Supabase CRM with live client data, which is
 * why that version stays private. This one keeps the same rules (touch
 * cadence, working-day scheduling, per-lead time zones and holidays) on
 * fictional companies, saved in the same JSON store as everything else.
 */
import type { JsonStore } from "../store.js";
import { addWorkingDays, dayAdd, toMinutes, zonedInstant, zonedParts, type Holiday, type WindowRules } from "./worktime.js";

export const STATUSES = ["new", "contacted", "replied", "meeting", "won", "lost"] as const;
export type Status = (typeof STATUSES)[number];
export const CHANNELS = ["email", "linkedin", "phone", "whatsapp"] as const;

export interface Lead {
  id: string;
  company: string;
  contact: string;
  email: string;
  timezone: string;
  /** Whose public holidays apply: NG, US or GB. */
  region: string;
  status: Status;
  touchCount: number;
  /** ISO time of the next planned touch. */
  nextActionDate?: string;
  notes: string[];
}

export interface Project {
  name: string;
  sendStart: string;
  sendEnd: string;
  /** Working days to wait after touch 1, 2, 3... The last gap repeats. */
  cadenceDays: number[];
  maxTouches: number;
}

export interface Touch {
  leadId: string;
  touchNumber: number;
  channel: string;
  note?: string;
  at: string;
}

interface CrmData {
  project: Project;
  leads: Record<string, Lead>;
  holidays: Holiday[];
  touches: Touch[];
}

const KEY = "crm";

export class Crm {
  constructor(
    private readonly store: JsonStore,
    seedNow = new Date(),
  ) {
    if (!store.get(KEY)) store.set(KEY, demoData(seedNow));
  }

  private data(): CrmData {
    return this.store.get<CrmData>(KEY)!;
  }

  private write(fn: (d: CrmData) => CrmData): void {
    this.store.set(KEY, fn(this.data()));
  }

  project(): Project {
    return this.data().project;
  }

  holidays(): Holiday[] {
    return this.data().holidays;
  }

  leads(): Lead[] {
    return Object.values(this.data().leads);
  }

  lead(id: string): Lead | undefined {
    return this.data().leads[id.toUpperCase()];
  }

  touches(leadId: string): Touch[] {
    return this.data().touches.filter((t) => t.leadId === leadId);
  }

  rules(lead: Lead): WindowRules {
    const p = this.project();
    return { timezone: lead.timezone, sendStart: p.sendStart, sendEnd: p.sendEnd, holidayRegion: lead.region };
  }

  saveLead(lead: Lead): void {
    this.write((d) => ({ ...d, leads: { ...d.leads, [lead.id]: lead } }));
  }

  deleteLead(id: string): boolean {
    const key = id.toUpperCase();
    if (!this.data().leads[key]) return false;
    this.write((d) => {
      const { [key]: _gone, ...rest } = d.leads;
      return { ...d, leads: rest, touches: d.touches.filter((t) => t.leadId !== key) };
    });
    return true;
  }

  addTouch(touch: Touch): void {
    this.write((d) => ({ ...d, touches: [...d.touches, touch] }));
  }

  /** When the next touch is due: the cadence gap in working days, at the start of the lead's window. */
  nextActionAfter(lead: Lead, touchNumber: number, now = new Date()): string | undefined {
    const p = this.project();
    if (touchNumber >= p.maxTouches) return undefined;
    const gap = p.cadenceDays[touchNumber - 1] ?? p.cadenceDays[p.cadenceDays.length - 1] ?? 3;
    const today = zonedParts(now, lead.timezone).day;
    const day = addWorkingDays(today, gap, lead.region, this.holidays());
    return zonedInstant(day, toMinutes(p.sendStart), lead.timezone).toISOString();
  }
}

// ── Demo data ──────────────────────────────────────────────────────────────
// Fictional companies on .example addresses. Dates are set relative to the
// first run, so there is always something due when you try it.

const SEED: [string, string, string, string, string][] = [
  ["Northwind Freight", "Ada Okafor", "northwind", "Africa/Lagos", "NG"],
  ["Kestrel Clinics", "Tunde Bello", "kestrel", "Africa/Lagos", "NG"],
  ["Harbor & Pine Legal", "Megan Holt", "harborpine", "America/New_York", "US"],
  ["Brightloom Studios", "Oliver Grant", "brightloom", "Europe/London", "GB"],
  ["Copperline Solar", "Ngozi Eze", "copperline", "Africa/Lagos", "NG"],
  ["Fieldstone Analytics", "Ryan Cole", "fieldstone", "America/Chicago", "US"],
  ["Marigold Foods", "Funke Adeyemi", "marigold", "Africa/Lagos", "NG"],
  ["Tidewater Logistics", "Dana Reyes", "tidewater", "America/New_York", "US"],
  ["Quillstack Software", "Priya Shah", "quillstack", "Europe/London", "GB"],
  ["Ember & Oak Furniture", "Luke Parker", "emberoak", "America/Chicago", "US"],
  ["Sablewood Hotels", "Chidi Nwosu", "sablewood", "Africa/Lagos", "NG"],
  ["Lumen Ridge Health", "Sara Kim", "lumenridge", "America/New_York", "US"],
  ["Oakhaven Realty", "Kemi Lawal", "oakhaven", "Africa/Lagos", "NG"],
  ["Pinegrove Insurance Brokers", "James Wright", "pinegrove", "Europe/London", "GB"],
];

/** A demo list. Check your own government's published dates before relying on them. */
const DEMO_HOLIDAYS: Holiday[] = [
  { day: "2026-12-25", region: "NG" },
  { day: "2026-12-28", region: "NG" },
  { day: "2027-01-01", region: "NG" },
  { day: "2026-11-26", region: "US" },
  { day: "2026-12-25", region: "US" },
  { day: "2027-01-01", region: "US" },
  { day: "2026-12-25", region: "GB" },
  { day: "2026-12-28", region: "GB" },
  { day: "2027-01-01", region: "GB" },
];

export function demoData(now: Date): CrmData {
  const project: Project = { name: "Demo outbound", sendStart: "09:00", sendEnd: "17:00", cadenceDays: [2, 3, 4, 7], maxTouches: 5 };
  const leads: Record<string, Lead> = {};
  SEED.forEach(([company, contact, slug, timezone, region], i) => {
    const id = `L-${String(i + 1).padStart(3, "0")}`;
    const today = zonedParts(now, timezone).day;
    // Two thirds due today or overdue, the rest later this week.
    const offset = i % 3 === 2 ? 2 : -(i % 2);
    leads[id] = {
      id,
      company,
      contact,
      email: `${contact.split(" ")[0]!.toLowerCase()}@${slug}.example`,
      timezone,
      region,
      status: i % 4 === 0 ? "new" : "contacted",
      touchCount: i % 4 === 0 ? 0 : 1,
      nextActionDate: zonedInstant(dayAdd(today, offset), toMinutes(project.sendStart), timezone).toISOString(),
      notes: [],
    };
  });
  return { project, leads, holidays: DEMO_HOLIDAYS, touches: [] };
}
