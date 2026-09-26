// The chart symbol's exchange calendar: its timezone, its market type and its weekly session
// schedule (transpile's syminfo option, AnalyzeOptions.syminfo). TradingView lays the periods of a
// timeframe on it. A trading day begins at the session open (an FX Monday opens Sunday 17:00 New
// York), intraday periods count from the session start, and multi-period (nD/nW/nM) periods group
// the scheduled days, weeks or months of each year. timeframe.change reads it (ref_v6_lang.txt
// timeframe.change: "Returns true on the first bar of a new `timeframe`, false otherwise").
//
// The rules are those of the reference implementation certified against TradingView (pynecore
// lib/_timeframe_change.py, lib/timeframe.py _is_new_session, core/resampler.py); tier 1
// tf_010_change and tf_011_change2 are TradingView exports of timeframe.change on a CAPITALCOM
// EURUSD 5m and 240m chart.
//
// Local times are "wall" milliseconds: the exchange's wall clock read as if it were UTC, so the
// Date getUTC* accessors return the local fields. The reference runs its session arithmetic on
// wall-clock datetimes of one timezone (Python adds and compares them as naive), and wall
// milliseconds reproduce that exactly, across daylight-saving changes included.

import { FIXED_OFFSET_TZ_RE, getIanaZoneFormatter } from "./datetime";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// Offsets are cached per 15-minute bucket, checked at both ends of the bucket, so a transition
// inside one is computed exactly.
const OFFSET_BUCKET_MS = 900_000;

// Weekdays are numbered as the symbol's session schedule numbers them: 0 = Monday … 6 = Sunday.
// Day number 0 (1970-01-01) was a Thursday.
export function weekdayOf(dayNumber: number): number {
  return (((dayNumber + 3) % 7) + 7) % 7;
}

function floorMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

// [weekday, open, close] (seconds of the day) and [weekday, time] (seconds of the day) of a session
// start or end.
export type SessionInterval = readonly [day: number, start: number, end: number];
export type SessionStart = readonly [day: number, time: number];

export interface CalendarSpec {
  chartTf: string;
  timezone: string;
  type: string;
  openingHours: readonly SessionInterval[];
  sessionStarts: readonly SessionStart[];
  sessionEnds: readonly SessionStart[];
}

// A symbol's calendar as a caller writes it (the calendar keys of transpile's syminfo option):
// day 0 = Monday … 6 = Sunday, "HH:MM[:SS]" times in the symbol's timezone.
export interface SymbolCalendarOptions {
  timezone?: string;
  type?: string;
  opening_hours?: readonly { day: number; start: string; end: string }[];
  session_starts?: readonly { day: number; time: string }[];
  session_ends?: readonly { day: number; time: string }[];
}

function secondsOfDay(v: unknown, what: string): number {
  const m = typeof v === "string" ? /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v) : null;
  const h = m === null ? NaN : Number(m[1]);
  const mi = m === null ? NaN : Number(m[2]);
  const s = m === null || m[3] === undefined ? 0 : Number(m[3]);
  if (!(h < 24 && mi < 60 && s < 60)) throw new Error(`${what}: invalid time of day ${JSON.stringify(v)}`);
  return h * 3600 + mi * 60 + s;
}

function weekday(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 6) throw new Error(`${what}: invalid day ${JSON.stringify(v)}`);
  return v;
}

// The CalendarSpec of a symbol whose bars have timeframe `tf`. Without a schedule the market is
// open around the clock, every day from 00:00 to 23:59:59, as the chart's is by default (analyzer
// resolveSymbolCalendar); the timezone defaults to UTC and the type to "stock".
export function calendarSpecOf(tf: string, opts: SymbolCalendarOptions | undefined, what: string): CalendarSpec {
  const days = [0, 1, 2, 3, 4, 5, 6];
  const scheduled = opts?.opening_hours !== undefined || opts?.session_starts !== undefined || opts?.session_ends !== undefined;
  return {
    chartTf: tf,
    timezone: opts?.timezone ?? "UTC",
    type: opts?.type ?? "stock",
    openingHours: scheduled
      ? (opts!.opening_hours ?? []).map((oh) => [weekday(oh.day, what), secondsOfDay(oh.start, what), secondsOfDay(oh.end, what)] as const)
      : days.map((d) => [d, 0, 86_399] as const),
    sessionStarts: scheduled
      ? (opts!.session_starts ?? []).map((ss) => [weekday(ss.day, what), secondsOfDay(ss.time, what)] as const)
      : days.map((d) => [d, 0] as const),
    sessionEnds: scheduled
      ? (opts!.session_ends ?? []).map((se) => [weekday(se.day, what), secondsOfDay(se.time, what)] as const)
      : days.map((d) => [d, 86_399] as const),
  };
}

// A timeframe string as [modifier, multiplier]: "5" -> ["", 5], "1D"/"D" -> ["D", 1], "3W" ->
// ["W", 3], "30S" -> ["S", 30] (concepts_timeframes.txt "Timeframe string specifications").
export function parseTimeframe(tf: string): [string, number] {
  let modifier: string;
  let multiplier: number;
  if (/^\d+$/.test(tf)) {
    modifier = "";
    multiplier = parseInt(tf, 10);
  } else if (tf.length > 1 && /^\d+[TSDWM]$/.test(tf)) {
    modifier = tf[tf.length - 1]!;
    multiplier = parseInt(tf.slice(0, -1), 10);
  } else if (tf.length === 1 && /^[TSDWM]$/.test(tf)) {
    modifier = tf;
    multiplier = 1;
  } else {
    throw new Error(`invalid timeframe: '${tf}'`);
  }
  if (!(multiplier > 0)) throw new Error(`invalid timeframe: '${tf}'`);
  return [modifier, multiplier];
}

// The span of a timeframe in seconds, as TradingView measures it to compare two timeframes: a
// month is 365/12 days plus 3 seconds (pynecore lib/timeframe.py _in_seconds: "Don't know why, but
// TV adds 3 secs here").
export function timeframeSeconds(modifier: string, multiplier: number): number {
  switch (modifier) {
    case "":
      return multiplier * 60;
    case "S":
      return multiplier;
    case "D":
      return multiplier * 86_400;
    case "W":
      return multiplier * 604_800;
    case "M":
      return Math.trunc(multiplier * (86_400 * (365 / 12) + 3));
    default:
      throw new Error("tick timeframes are not supported");
  }
}

// Which days a multi-period grid counts. 24/7 markets (a schedule covering all seven days, or a
// crypto type) count every calendar day; FX counts Monday to Friday, holidays included; exchange
// listed symbols count the days the exchange actually traded (core/resampler.py grid_mode).
export type GridMode = "calendar" | "weekday" | "observed";

export function gridMode(type: string, openingHours: readonly SessionInterval[]): GridMode {
  if (new Set(openingHours.map(([day]) => day)).size === 7) return "calendar";
  if (type === "crypto" || type === "spot" || type === "swap") return "calendar";
  if (type === "forex") return "weekday";
  return "observed";
}

// Index of a date among its year's Monday-to-Friday weekdays (core/resampler.py weekday_ordinal).
function weekdayOrdinal(dayNumber: number, jan1: number): number {
  const days = dayNumber - jan1;
  const weeks = Math.floor(days / 7);
  const rem = days - weeks * 7;
  const w0 = weekdayOf(jan1);
  let n = weeks * 5;
  for (let i = 0; i < rem; i++) if ((w0 + i) % 7 < 5) n += 1;
  return n;
}

export class ExchangeCalendar {
  readonly chartTf: string;
  readonly chartModifier: string;
  readonly chartMultiplier: number;
  readonly chartSeconds: number;
  // A chart bar belongs to the period its last instant falls in: the bar holding a session open is
  // the new trading day's first bar even when it opens before it (a 17:05 open on a 240-minute
  // chart makes the 17:00 bar the new day's). Daily and longer chart bars are session-aligned
  // already (lib/__init__.py _chart_span_off_ms).
  readonly chartSpanOffMs: number;
  readonly gridMode: GridMode;
  // Session starts and ends per weekday, milliseconds of the day.
  private readonly startsByDay: number[][] = [[], [], [], [], [], [], []];
  private readonly endsByDay: number[][] = [[], [], [], [], [], [], []];
  // Opens of the sessions that run past midnight (close before open), per weekday.
  private readonly overnightByDay: number[][] = [[], [], [], [], [], [], []];
  // The earliest open per weekday that begins the next day's trading day (an overnight session
  // not opening at midnight; core/resampler.py overnight_opens / rolls_trading_day).
  private readonly rollOpen: (number | undefined)[] = new Array(7).fill(undefined);
  private readonly openingHours: readonly SessionInterval[];
  private readonly fixedOffsetMs: number | null;
  private readonly formatter: Intl.DateTimeFormat | null;
  private readonly offsetCache = new Map<number, number>();

  constructor(spec: CalendarSpec) {
    this.chartTf = spec.chartTf;
    [this.chartModifier, this.chartMultiplier] = parseTimeframe(spec.chartTf);
    this.chartSeconds = timeframeSeconds(this.chartModifier, this.chartMultiplier);
    this.chartSpanOffMs = this.chartModifier === "" || this.chartModifier === "S" ? this.chartSeconds * 1000 - 1 : 0;
    this.gridMode = gridMode(spec.type, spec.openingHours);
    this.openingHours = spec.openingHours;
    for (const [day, time] of spec.sessionStarts) this.startsByDay[day]!.push(time * 1000);
    for (const [day, time] of spec.sessionEnds) this.endsByDay[day]!.push(time * 1000);
    const noteRollOpen = (day: number, start: number): void => {
      const cur = this.rollOpen[day];
      if (cur === undefined || start * 1000 < cur) this.rollOpen[day] = start * 1000;
    };
    for (const [day, start, end] of spec.openingHours) {
      if (end < start) this.overnightByDay[day]!.push(start * 1000);
      if (end <= start && start !== 0) noteRollOpen(day, start);
    }
    // Without opening hours, an open at or after noon is taken as the evening open of the next
    // trading day (overnight_opens: "true for every overnight market we know").
    if (spec.openingHours.length === 0) {
      for (const [day, time] of spec.sessionStarts) if (time >= 43_200) noteRollOpen(day, time);
    }
    const fixed = FIXED_OFFSET_TZ_RE.exec(spec.timezone);
    if (fixed !== null) {
      const h = parseInt(fixed[1]!, 10);
      const m = fixed[2] !== undefined ? parseInt(fixed[2], 10) : 0;
      this.fixedOffsetMs = (h * 60 + (h < 0 ? -m : m)) * 60_000;
      this.formatter = null;
    } else {
      this.fixedOffsetMs = null;
      this.formatter = getIanaZoneFormatter(spec.timezone);
      if (this.formatter === null) throw new Error(`unknown timezone: '${spec.timezone}'`);
    }
  }

  private exactOffset(ms: number): number {
    const sec = Math.floor(ms / 1000) * 1000;
    const parts = this.formatter!.formatToParts(new Date(sec));
    let y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0;
    for (const p of parts) {
      if (p.type === "year") y = Number(p.value);
      else if (p.type === "month") mo = Number(p.value);
      else if (p.type === "day") d = Number(p.value);
      else if (p.type === "hour") h = Number(p.value) % 24;
      else if (p.type === "minute") mi = Number(p.value);
      else if (p.type === "second") s = Number(p.value);
    }
    return Date.UTC(y, mo - 1, d, h, mi, s) - sec;
  }

  // Exchange wall-clock milliseconds of an instant.
  wall(ms: number): number {
    if (this.fixedOffsetMs !== null) return ms + this.fixedOffsetMs;
    const bucket = Math.floor(ms / OFFSET_BUCKET_MS);
    let off = this.offsetCache.get(bucket);
    if (off === undefined) {
      const lo = this.exactOffset(bucket * OFFSET_BUCKET_MS);
      const hi = this.exactOffset((bucket + 1) * OFFSET_BUCKET_MS - 1000);
      if (lo !== hi) return ms + this.exactOffset(ms);
      off = lo;
      this.offsetCache.set(bucket, off);
    }
    return ms + off;
  }

  // The instant of an exchange wall-clock time, the inverse of wall(). A wall time that occurs
  // twice (the hour a daylight-saving change repeats) resolves to its first occurrence, one that
  // does not occur (the hour skipped) with the offset in force before the change, as the
  // reference's zone-aware datetime does (fold 0).
  unwall(wallMs: number): number {
    if (this.fixedOffsetMs !== null) return wallMs - this.fixedOffsetMs;
    const before = this.wall(wallMs - 86_400_000) - (wallMs - 86_400_000);
    const after = this.wall(wallMs + 86_400_000) - (wallMs + 86_400_000);
    const early = wallMs - before;
    if (this.wall(early) === wallMs) return early;
    const late = wallMs - after;
    return this.wall(late) === wallMs ? late : early;
  }

  // The scheduled close of a bar of timeframe `tf` opening at `openMs` (core/security.py
  // actual_bar_close, the instant a request.security consumer pairs bars by; unix ms, exclusive):
  // - intraday: the earliest of open + the timeframe's span, the next bar's open (`nextOpenMs`,
  //   0 when there is none) and the end of the session holding the open;
  // - daily, weekly, monthly: the end of the last scheduled session in the bar's period, a day,
  //   the Monday-to-Sunday week or the month of the open's trading day, else the period's civil
  //   end. The periods of nD/nW/nM (n > 1) are not modelled here: such a bar closes at the next
  //   bar's open, or a span after its own open when it is the last.
  // Holidays and early closes are not in a weekly schedule, so a bar closes where the schedule
  // says; the reference does the same.
  barClose(openMs: number, nextOpenMs: number, tf: string): number {
    const [modifier, multiplier] = parseTimeframe(tf);
    const spanMs = timeframeSeconds(modifier, multiplier) * 1000;
    if (modifier === "" || modifier === "S") {
      let close = openMs + spanMs;
      if (nextOpenMs > 0 && nextOpenMs < close) close = nextOpenMs;
      const end = this.sessionEndOf(openMs);
      return end !== null && end < close ? end : close;
    }
    if (multiplier > 1) return nextOpenMs > 0 ? nextOpenMs : openMs + spanMs;
    const first = this.tradingDay(this.wall(openMs));
    let last: number;
    if (modifier === "D") {
      last = first;
    } else if (modifier === "W") {
      last = first - weekdayOf(first) + 6;
    } else {
      const date = new Date(first * DAY_MS);
      last = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / DAY_MS - 1;
    }
    for (let day = last; day >= first; day--) {
      const end = this.tradingDayEnd(day);
      if (end === null) continue;
      const endMs = this.exclusiveEnd(end);
      if (endMs > openMs) return endMs;
    }
    return this.unwall((last + 1) * DAY_MS);
  }

  // A session end as an exclusive instant: 23:59:59 is the schedule's way of writing midnight
  // (core/security.py _exclusive_session_end), so such a session runs to the next day's 00:00.
  private exclusiveEnd(endWall: number): number {
    const ms = this.unwall(endWall);
    return floorMod(endWall, DAY_MS) === DAY_MS - 1000 ? ms + 1000 : ms;
  }

  // The end (wall ms) of the session holding an instant, the earliest when several do, or null
  // when the schedule has none there (core/security.py _session_end_of_open): a session of the
  // instant's weekday from its open, running into the next day when it closes at or before it
  // opens, or the part after midnight of the previous weekday's overnight session.
  private sessionEndOf(ms: number): number | null {
    const w = this.wall(ms);
    const day = Math.floor(w / DAY_MS);
    const t = w - day * DAY_MS;
    const weekday = weekdayOf(day);
    const prevWeekday = (weekday + 6) % 7;
    let best: number | null = null;
    for (const [d, start, end] of this.openingHours) {
      const overnight = end <= start;
      let endWall: number;
      if (d === weekday && t >= start * 1000 && (overnight || t < end * 1000)) {
        endWall = (day + (overnight ? 1 : 0)) * DAY_MS + end * 1000;
      } else if (d === prevWeekday && overnight && t < end * 1000) {
        endWall = day * DAY_MS + end * 1000;
      } else {
        continue;
      }
      const endMs = this.exclusiveEnd(endWall);
      if (best === null || endMs < best) best = endMs;
    }
    return best;
  }

  // The scheduled end (wall ms) of a trading day, the last of its sessions, or null when it has
  // none (core/resampler.py trading_day_end_sec): a day session of its weekday, or an overnight
  // session opening the evening before. A session round the clock (00:00-00:00) has no end in it.
  private tradingDayEnd(day: number): number | null {
    const weekday = weekdayOf(day);
    let best: number | null = null;
    for (const [d, start, end] of this.openingHours) {
      const rolls = end <= start && start !== 0;
      if (rolls ? (d + 1) % 7 !== weekday : d !== weekday || end <= start) continue;
      const endWall = day * DAY_MS + end * 1000;
      if (best === null || endWall > best) best = endWall;
    }
    return best;
  }

  // The trading day (day number) of a wall time: its calendar date, or the next one at or after its
  // weekday's rolling overnight open (core/resampler.py trading_day).
  tradingDay(wallMs: number): number {
    const day = Math.floor(wallMs / DAY_MS);
    const roll = this.rollOpen[weekdayOf(day)];
    return roll !== undefined && wallMs - day * DAY_MS >= roll ? day + 1 : day;
  }

  // The trading day of a chart bar, judged at its last instant (lib/__init__.py _dg_trading_day).
  barTradingDay(barTimeMs: number): number {
    return this.tradingDay(this.wall(barTimeMs) + this.chartSpanOffMs);
  }

  // Whether a session starts within the chart bar opening at wall time `cur`, after the previous
  // bar's open `prev` (lib/timeframe.py _is_new_session): the starts scheduled on its weekday, and
  // when the weekday changed, the opens of the previous weekday's overnight sessions.
  isNewSession(cur: number, prev: number, barMs: number): boolean {
    const curDay = Math.floor(cur / DAY_MS);
    const curWeekday = weekdayOf(curDay);
    const prevWeekday = weekdayOf(Math.floor(prev / DAY_MS));
    const curTime = cur - curDay * DAY_MS;
    const starts = (list: number[]): boolean => {
      for (const t of list) {
        let start = curDay * DAY_MS + t;
        if (prevWeekday !== curWeekday && t > curTime) start -= DAY_MS;
        if (cur <= start && start < cur + barMs && start > prev) return true;
      }
      return false;
    };
    if (starts(this.startsByDay[curWeekday]!)) return true;
    return prevWeekday !== curWeekday && starts(this.overnightByDay[prevWeekday]!);
  }

  // session.isfirstbar and session.isfirstbar_regular: "true if the current bar is the first bar of
  // the day's session" (ref_v6_lang.txt). The first bar is the chart bar whose span holds a session
  // start: a start scheduled on the weekday of the bar's open, at or after the open and before the
  // open plus the chart timeframe (pynecore lib/session.py isfirstbar_regular). Tier 1
  // session_001_properties: on a 60-minute CAPITALCOM EURUSD chart the 17:00 bar holds the 17:05
  // Monday-Thursday start and the Sunday 17:00 start. Extended sessions are not modelled, so both
  // variables read the same (regular) schedule.
  isSessionFirstBar(barTimeMs: number): boolean {
    const w = this.wall(barTimeMs);
    const day = Math.floor(w / DAY_MS);
    const spanMs = this.chartSeconds * 1000;
    for (const t of this.startsByDay[weekdayOf(day)]!) {
      const start = day * DAY_MS + t;
      if (w <= start && start < w + spanMs) return true;
    }
    return false;
  }

  // session.islastbar and session.islastbar_regular: "true if the current bar is the last bar of the
  // day's session" (ref_v6_lang.txt). The last bar is the chart bar whose span holds a session end:
  // an end scheduled on the weekday of the bar's open, after the open and at or before the open plus
  // the chart timeframe; an end at or before the open is the day's midnight close (00:00 = 24:00 on a
  // 24/7 market), taken on the next day (pynecore lib/session.py islastbar_regular). Tier 1
  // session_001_properties: the 16:00 bar holds the 16:59:50 end; session_002_24x7: the 23:00 bar
  // holds the 00:00 end.
  isSessionLastBar(barTimeMs: number): boolean {
    const w = this.wall(barTimeMs);
    const day = Math.floor(w / DAY_MS);
    const spanMs = this.chartSeconds * 1000;
    for (const t of this.endsByDay[weekdayOf(day)]!) {
      let end = day * DAY_MS + t;
      if (end <= w) end += DAY_MS;
      if (w < end && end <= w + spanMs) return true;
    }
    return false;
  }

  // session.ismarket: "true if the current bar is a part of the regular trading hours" (ref_v6_lang.txt).
  // The chart bar's span [open, open + chart timeframe) overlaps an interval of the opening hours: one
  // of its weekday, or the part after midnight of the previous weekday's overnight session (pynecore
  // core/session.py is_in_session). A session closing at or before it opens runs into the next day,
  // as sessionEndOf reads it, so a 00:00-00:00 day is open around the clock: concepts_sessions.txt
  // "For tickers without pre-market and post-market sessions, such as “BTCUSD”, session.ismarket is
  // always true" (the reference runs a session into the next day only when it closes strictly before
  // it opens, which leaves a 00:00-00:00 day closed; resin-harness state/disputes.md D5).
  isMarketBar(barTimeMs: number): boolean {
    const w = this.wall(barTimeMs);
    const day = Math.floor(w / DAY_MS);
    const weekday = weekdayOf(day);
    const prevWeekday = (weekday + 6) % 7;
    const barEnd = w + this.chartSeconds * 1000;
    for (const [d, start, end] of this.openingHours) {
      const overnight = end <= start;
      let open: number;
      let close: number;
      if (d === prevWeekday && overnight) {
        open = (day - 1) * DAY_MS + start * 1000;
        close = day * DAY_MS + end * 1000;
      } else if (d === weekday) {
        open = day * DAY_MS + start * 1000;
        close = (day + (overnight ? 1 : 0)) * DAY_MS + end * 1000;
      } else {
        continue;
      }
      if (barEnd > open && w < close) return true;
    }
    return false;
  }

  // Identity of the nD/nW/nM period (multiplier > 1) holding a chart bar, on the year-reset grid
  // (core/resampler.py Resampler.get_bar_time): days count the year's scheduled days from its
  // first, weeks count from the year's first Monday (a week belongs to its Monday's year), months
  // group within the year. The nD grid of an "observed" symbol counts the days its exchange
  // actually traded, a holiday calendar resin does not have: resin counts its weekdays, the
  // reference's own fallback outside the data it has seen.
  multiPeriodKey(modifier: string, multiplier: number, barTimeMs: number): number {
    const eff = Math.floor((barTimeMs + this.chartSpanOffMs) / 1000) * 1000;
    const td = this.tradingDay(this.wall(eff));
    const date = new Date(td * DAY_MS);
    const year = date.getUTCFullYear();
    if (modifier === "D") {
      const jan1 = Date.UTC(year, 0, 1) / DAY_MS;
      const idx = this.gridMode === "calendar" ? td - jan1 : weekdayOrdinal(td, jan1);
      return year * 1000 + Math.floor(idx / multiplier);
    }
    if (modifier === "W") {
      const monday = td - weekdayOf(td);
      const mondayYear = new Date(monday * DAY_MS).getUTCFullYear();
      const jan1 = Date.UTC(mondayYear, 0, 1) / DAY_MS;
      const w0 = weekdayOf(jan1);
      const firstMonday = jan1 + (w0 === 0 ? 0 : 7 - w0);
      return mondayYear * 100 + Math.floor((monday - firstMonday) / 7 / multiplier);
    }
    return year * 100 + Math.floor(date.getUTCMonth() / multiplier);
  }
}

export interface TimeframeChangeState {
  // Intraday: the replayed chart bar and the session anchor it counts from (wall ms).
  lastBar?: number;
  anchor?: number;
  // Daily and longer: the period of the previous call.
  period?: number;
}

// timeframe.change(timeframe): true on the first chart bar of a new `timeframe` period, never on
// the first bar a call site sees, and never for a timeframe shorter than the chart's. An empty
// timeframe is the chart's own (measured on TradingView: timeframe.change("") never differs from
// timeframe.change(timeframe.period)).
//
// Intraday: the chart's bars are replayed one span at a time, those missing from the data
// included, from the previous call to this bar; a session start moves the anchor to the start of
// its hour, and a replayed bar whose distance from the anchor is a whole number of `timeframe`
// spans starts a period — this bar reports it, and the replay jumps to this bar.
//
// Daily, weekly, monthly: the period is the bar's trading day, the Monday of its trading day's
// week, or its trading day's month; nD/nW/nM periods come from ExchangeCalendar.multiPeriodKey, and
// a timeframe equal to the chart's starts a period on every bar.
export function change(
  state: TimeframeChangeState,
  timeframe: string | null | undefined,
  barTimeMs: number,
  barIndex: number,
  cal: ExchangeCalendar,
): boolean {
  const tf = timeframe ? timeframe : cal.chartTf;
  const [modifier, multiplier] = parseTimeframe(tf);
  const tfSeconds = timeframeSeconds(modifier, multiplier);
  if (tfSeconds < cal.chartSeconds) return false;

  if (modifier === "" || modifier === "S") {
    const dt = cal.wall(barTimeMs);
    const barMs = cal.chartSeconds * 1000;
    let lastBar = state.lastBar ?? dt - barMs;
    let anchor = state.anchor ?? lastBar;
    let starts = false;
    while (lastBar < dt) {
      const prev = lastBar;
      lastBar += barMs;
      if (cal.isNewSession(lastBar, prev, barMs)) anchor = lastBar - floorMod(lastBar, HOUR_MS);
      if (((lastBar - anchor) / 1000) % tfSeconds === 0) {
        lastBar = dt;
        starts = true;
        break;
      }
    }
    state.lastBar = lastBar;
    state.anchor = anchor;
    return starts && barIndex > 0;
  }

  let period: number;
  if (multiplier > 1) {
    period =
      modifier === cal.chartModifier && multiplier === cal.chartMultiplier
        ? barTimeMs
        : cal.multiPeriodKey(modifier, multiplier, barTimeMs);
  } else {
    const td = cal.barTradingDay(barTimeMs);
    if (modifier === "D") {
      period = td;
    } else if (modifier === "W") {
      period = td - weekdayOf(td);
    } else {
      const date = new Date(td * DAY_MS);
      period = date.getUTCFullYear() * 12 + date.getUTCMonth();
    }
  }
  if (period !== state.period) {
    const first = state.period === undefined;
    state.period = period;
    if (!first) return barIndex > 0;
  }
  return false;
}
