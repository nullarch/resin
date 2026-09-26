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

// [weekday, open, close] (seconds of the day) and [weekday, start] (seconds of the day).
export type SessionInterval = readonly [day: number, start: number, end: number];
export type SessionStart = readonly [day: number, time: number];

export interface CalendarSpec {
  chartTf: string;
  timezone: string;
  type: string;
  openingHours: readonly SessionInterval[];
  sessionStarts: readonly SessionStart[];
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
  // Session starts per weekday, milliseconds of the day.
  private readonly startsByDay: number[][] = [[], [], [], [], [], [], []];
  // Opens of the sessions that run past midnight (close before open), per weekday.
  private readonly overnightByDay: number[][] = [[], [], [], [], [], [], []];
  // The earliest open per weekday that begins the next day's trading day (an overnight session
  // not opening at midnight; core/resampler.py overnight_opens / rolls_trading_day).
  private readonly rollOpen: (number | undefined)[] = new Array(7).fill(undefined);
  private readonly fixedOffsetMs: number | null;
  private readonly formatter: Intl.DateTimeFormat | null;
  private readonly offsetCache = new Map<number, number>();

  constructor(spec: CalendarSpec) {
    this.chartTf = spec.chartTf;
    [this.chartModifier, this.chartMultiplier] = parseTimeframe(spec.chartTf);
    this.chartSeconds = timeframeSeconds(this.chartModifier, this.chartMultiplier);
    this.chartSpanOffMs = this.chartModifier === "" || this.chartModifier === "S" ? this.chartSeconds * 1000 - 1 : 0;
    this.gridMode = gridMode(spec.type, spec.openingHours);
    for (const [day, time] of spec.sessionStarts) this.startsByDay[day]!.push(time * 1000);
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
