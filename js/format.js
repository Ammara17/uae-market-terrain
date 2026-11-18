// Number and date formatting shared by every view.

const MINUS = "−";

const price2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const price3 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const shortDayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const monthFmt = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });
const stampFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Dubai",
  timeZoneName: "short",
});

/** UAE tick sizes: three decimals below AED 1, two above. */
export function price(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return (Math.abs(value) < 1 ? price3 : price2).format(value);
}

export function signedPrice(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const body = price(Math.abs(value));
  return value > 0 ? `+${body}` : value < 0 ? `${MINUS}${body}` : body;
}

/** 0.1234 → "+12.3%" using a true minus sign for negatives. */
export function pct(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "—";
  const body = Math.abs(value * 100).toFixed(digits);
  if (Number(body) === 0) return `${(0).toFixed(digits)}%`;
  return `${value > 0 ? "+" : MINUS}${body}%`;
}

export function unsignedPct(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function compact(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return compactFmt.format(value);
}

export function direction(value) {
  if (value == null || !Number.isFinite(value) || Math.abs(value) < 0.0005) return "flat";
  return value > 0 ? "up" : "down";
}

function toDate(iso) {
  return new Date(`${iso}T00:00:00Z`);
}

export function day(iso) {
  return dayFmt.format(toDate(iso));
}

export function shortDay(iso) {
  return shortDayFmt.format(toDate(iso));
}

export function month(iso) {
  return monthFmt.format(toDate(iso));
}

export function stamp(isoDateTime) {
  const date = new Date(isoDateTime);
  return Number.isNaN(date.getTime()) ? isoDateTime : stampFmt.format(date);
}

/** Index positions where a new calendar month starts, for axis ticks. */
export function monthStarts(dates, start, end) {
  const ticks = [];
  for (let i = start + 1; i <= end; i++) {
    if (dates[i].slice(0, 7) !== dates[i - 1].slice(0, 7)) ticks.push(i);
  }
  return ticks;
}

/** A tidy step for axis ticks: 1, 2, 2.5 or 5 × 10^n. */
export function niceStep(span, targetTicks = 4) {
  if (!(span > 0)) return 1;
  const raw = span / targetTicks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
  return nice * power;
}
