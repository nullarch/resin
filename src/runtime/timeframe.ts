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

// timeframe.period, timeframe.multiplier and the timeframe.is* flags of the timeframe `tf`. The
// script's own timeframe is the chart's, which the analyzer folds at compile time through this
// function (analyzer.ts timeframeStringPropValue and its siblings); within a request's expression
// it is the requested one (Context.secTf, codegen): ref_v6_lang.txt timeframe.period: "The
// variable's value represents the timeframe of a requested dataset when used in the `expression`
// argument of a `request.*()` function call. Otherwise, its value represents the script's main
// timeframe". timeframe.main_period "does not change when used in the `expression` argument", so
// it is always the chart's and never asked here. A flag follows the timeframe's unit whatever its
// multiplier ("2D" is daily), and isintraday holds for seconds, minutes and ticks, as the oracle
// reads them (pynecore lib/timeframe.py isdaily: `modifier == 'D'`, isintraday: `modifier == ''
// or modifier == 'S' or modifier == 'T'`). The period is the timeframe string as given.
export function variable(tf: string, attr: string): string | number | boolean | undefined {
  if (attr === "period") return tf;
  const [modifier, multiplier] = parseTimeframe(tf);
  switch (attr) {
    case "multiplier":
      return multiplier;
    case "isseconds":
      return modifier === "S";
    case "isminutes":
      return modifier === "";
    case "isticks":
      return modifier === "T";
    case "isintraday":
      return modifier === "" || modifier === "S" || modifier === "T";
    case "isdaily":
      return modifier === "D";
    case "isweekly":
      return modifier === "W";
    case "ismonthly":
      return modifier === "M";
    case "isdwm":
      return modifier === "D" || modifier === "W" || modifier === "M";
    default:
      return undefined;
  }
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
