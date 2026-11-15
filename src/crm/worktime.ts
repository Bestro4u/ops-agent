/**
 * Working days and hours, per lead time zone.
 *
 * Outreach should land inside the recipient's working day, not the sender's.
 * A team in Lagos writing to Chicago, London and Lagos needs three different
 * windows, and public holidays differ by country. These rules are pure
 * functions, so the agent's tools and the tests use exactly the same code.
 */

export const HOME_TZ = "Africa/Lagos";

export interface Holiday {
  day: string; // YYYY-MM-DD
  region: string; // NG, US, GB...
}

export interface WindowRules {
  timezone?: string;
  sendStart?: string; // "09:00"
  sendEnd?: string; // "17:00"
  holidayRegion?: string;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const SHORT_TZ: Record<string, string> = {
  "Africa/Lagos": "Lagos",
  "Europe/London": "UK",
  "America/New_York": "ET",
  "America/Chicago": "CT",
  "America/Denver": "MT",
  "America/Los_Angeles": "PT",
};

export const tzLabel = (tz: string) => SHORT_TZ[tz] ?? tz;

export function zonedParts(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const o = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  return { day: `${o.year}-${o.month}-${o.day}`, minutes: Number(o.hour) * 60 + Number(o.minute), weekday: WEEKDAY[o.weekday!]! };
}

export const toMinutes = (t?: string) => {
  const [h, m] = String(t || "09:00").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

export function dayAdd(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isoWeekday = (day: string) => {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
};

export const isWeekend = (day: string) => isoWeekday(day) > 5;

export const isWorkingDay = (day: string, region = "NG", holidays: Holiday[] = []) =>
  !isWeekend(day) && !holidays.some((h) => h.day === day && h.region === region);

/** n working days after `day`, landing on a working day even when n is 0. */
export function addWorkingDays(day: string, n: number, region = "NG", holidays: Holiday[] = []): string {
  let d = day;
  let left = Math.max(0, n || 0);
  while (left > 0) {
    d = dayAdd(d, 1);
    if (isWorkingDay(d, region, holidays)) left -= 1;
  }
  while (!isWorkingDay(d, region, holidays)) d = dayAdd(d, 1);
  return d;
}

/** The instant when the wall clock in `tz` shows `day` at `minutes` past midnight (handles DST). */
export function zonedInstant(day: string, minutes: number, tz: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const [py, pm, pd] = p.day.split("-").map(Number) as [number, number, number];
    const shown = Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
    if (shown === target) break;
    guess += target - shown;
  }
  return new Date(guess);
}

export interface SendWindow {
  open: boolean;
  reason: null | "weekend" | "holiday" | "before" | "after";
  tz: string;
  opensAt: Date | null;
  closesAt: Date | null;
}

export function sendWindow(rules: WindowRules, now = new Date(), holidays: Holiday[] = []): SendWindow {
  const tz = rules.timezone || HOME_TZ;
  const region = rules.holidayRegion || "NG";
  const start = toMinutes(rules.sendStart);
  const end = toMinutes(rules.sendEnd || "17:00");
  const p = zonedParts(now, tz);
  const working = isWorkingDay(p.day, region, holidays);

  let reason: SendWindow["reason"] = null;
  if (!working) reason = isWeekend(p.day) ? "weekend" : "holiday";
  else if (p.minutes < start) reason = "before";
  else if (p.minutes >= end) reason = "after";

  if (!reason) return { open: true, reason, tz, closesAt: zonedInstant(p.day, end, tz), opensAt: null };
  const openDay = working && p.minutes < start ? p.day : addWorkingDays(p.day, 1, region, holidays);
  return { open: false, reason, tz, opensAt: zonedInstant(openDay, start, tz), closesAt: null };
}

const clock = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
const weekdayName = (d: Date, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(d);

/** "Open until 23:00 Lagos (17:00 CT)" or "Opens Thu 15:00 Lagos (09:00 CT)", in the team's home time zone. */
export function describeWindow(w: SendWindow, now = new Date(), homeTz = HOME_TZ): string {
  const at = (w.open ? w.closesAt : w.opensAt)!;
  const sameDay = zonedParts(at, homeTz).day === zonedParts(now, homeTz).day;
  const when = `${sameDay ? "" : `${weekdayName(at, homeTz)} `}${clock(at, homeTz)} ${tzLabel(homeTz)}`;
  const local = w.tz === homeTz ? "" : ` (${clock(at, w.tz)} ${tzLabel(w.tz)})`;
  return w.open ? `Open until ${when}${local}` : `Opens ${when}${local}`;
}

/** Due when its next action falls on or before today, on the lead's own calendar. */
export function isDue(nextActionDate: string | undefined, tz: string, now = new Date()): boolean {
  if (!nextActionDate) return false;
  return zonedParts(new Date(nextActionDate), tz).day <= zonedParts(now, tz).day;
}
