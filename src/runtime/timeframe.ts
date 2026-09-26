import { parseTimeframe, timeframeSeconds } from "./calendar";

// timeframe.in_seconds(timeframe) returns "The "int" representation of the number of seconds in the
// timeframe string", the argument being "Optional. The default is timeframe.period"
// (ref_v6_lang.txt). The string follows the timeframe string specification (concepts_timeframes.txt:
// a multiplier and a unit letter, "S", "D", "W", "M" and none for minutes, 1 when the multiplier is
// omitted), and "When the timeframe is "1M" or more, calculations use 2628003 as the number of
// seconds in one month" — the span calendar.ts timeframeSeconds already measures. Tier 1
// resin-harness tf_002_in_seconds: "4D" 345600, "5W" 3024000, "M" 2628003, "2M" 5256006 (pine2py
// read every unit but D/W/M as 86400 and a month as 2592000).
//
// An empty or na argument is the chart's timeframe, as the oracle reads it (pynecore
// lib/timeframe.py _in_seconds `if not timeframe`); the chart timeframe is a compile-time constant
// that codegen passes when it is not resin's default "D". A string outside the specification (a
// tick timeframe, "1H", "abc") throws, as the oracle's _process_tf does.
export function in_seconds(timeframe?: string, chartTf = "D"): number {
  const [modifier, multiplier] = parseTimeframe(timeframe ? timeframe : chartTf);
  return timeframeSeconds(modifier, multiplier);
}

// timeframe.change lives in calendar.ts: it reads the symbol's exchange calendar.

// timeframe.from_seconds — pine2py wavealgo/__init__.py timeframe_from_seconds, literal port.
export function from_seconds(seconds: number): string {
  if (seconds <= 0) return "D";
  if (seconds < 60) {
    const rounded = Math.ceil(seconds / 5) * 5;
    return `${rounded}S`;
  }
  if (seconds < 86400) {
    return String(Math.ceil(seconds / 60));
  }
  if (seconds <= 604800 * 52) {
    if (seconds % 604800 === 0) {
      const weeks = seconds / 604800;
      return `${weeks}W`;
    }
    const days = Math.ceil(seconds / 86400);
    return `${days}D`;
  }
  return "12M";
}
