import { describe, expect, it } from "vitest";
import { addWorkingDays, describeWindow, isDue, sendWindow, zonedInstant } from "../src/crm/worktime.js";

const HOLIDAYS = [
  { day: "2026-10-01", region: "NG" },
  { day: "2026-10-12", region: "US" },
];
const CHICAGO = { timezone: "America/Chicago", holidayRegion: "US", sendStart: "09:00", sendEnd: "17:00" };
const LAGOS = { timezone: "Africa/Lagos", holidayRegion: "NG", sendStart: "09:00", sendEnd: "17:00" };

describe("working days", () => {
  it("counts working days and skips each region's own holidays", () => {
    expect(addWorkingDays("2026-10-09", 3, "NG", HOLIDAYS)).toBe("2026-10-14");
    expect(addWorkingDays("2026-10-09", 3, "US", HOLIDAYS)).toBe("2026-10-15");
    expect(addWorkingDays("2026-09-30", 1, "NG", HOLIDAYS)).toBe("2026-10-02");
  });

  it("lands on a working day even for a zero gap", () => {
    expect(addWorkingDays("2026-10-10", 0, "NG", HOLIDAYS)).toBe("2026-10-12");
  });
});

describe("send window", () => {
  it("opens Chicago at 15:00 Lagos and closes it at 23:00", () => {
    const at = new Date("2026-10-07T15:30:00Z");
    expect(describeWindow(sendWindow(CHICAGO, at, HOLIDAYS), at)).toBe("Open until 23:00 Lagos (17:00 CT)");
    const late = new Date("2026-10-07T22:30:00Z");
    expect(describeWindow(sendWindow(CHICAGO, late, HOLIDAYS), late)).toBe("Opens Thu 15:00 Lagos (09:00 CT)");
  });

  it("stays shut at weekends and on holidays, and says why", () => {
    const saturday = sendWindow(LAGOS, new Date("2026-10-10T10:00:00Z"), HOLIDAYS);
    expect(saturday).toMatchObject({ open: false, reason: "weekend" });
    expect(saturday.opensAt?.toISOString()).toBe("2026-10-12T08:00:00.000Z");
    expect(sendWindow(LAGOS, new Date("2026-10-01T10:00:00Z"), HOLIDAYS).reason).toBe("holiday");
  });

  it("opens later the same day when it is too early", () => {
    const early = sendWindow(LAGOS, new Date("2026-10-07T06:00:00Z"), HOLIDAYS);
    expect(early).toMatchObject({ open: false, reason: "before" });
    expect(early.opensAt?.toISOString()).toBe("2026-10-07T08:00:00.000Z");
  });
});

describe("time zones", () => {
  it("finds the right instant across daylight saving changes", () => {
    expect(zonedInstant("2026-12-01", 540, "America/Chicago").toISOString()).toBe("2026-12-01T15:00:00.000Z");
    expect(zonedInstant("2026-10-30", 540, "America/New_York").toISOString()).toBe("2026-10-30T13:00:00.000Z");
    expect(zonedInstant("2026-11-02", 540, "America/New_York").toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("dates due on the lead's own calendar", () => {
    const now = new Date("2026-10-07T15:30:00Z");
    expect(isDue("2026-10-07T14:00:00Z", "America/Chicago", now)).toBe(true);
    expect(isDue("2026-10-08T14:00:00Z", "America/Chicago", now)).toBe(false);
    expect(isDue(undefined, "America/Chicago", now)).toBe(false);
  });
});
