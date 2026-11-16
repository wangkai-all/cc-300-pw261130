// 时间都按"日"粒度处理（本地虚构数据，不接物流系统）。
export const DAY_MS = 86_400_000;

export function parseDay(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (!m) throw new Error(`无法识别的日期: ${value}`);
  return m[1];
}

export function parseTime(value) {
  if (value instanceof Date) return value.toISOString();
  const s = String(value);
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) throw new Error(`无法识别的时间: ${value}`);
  const t = `${m[1]}T${m[2] ?? '00'}:${m[3] ?? '00'}:${m[4] ?? '00'}.000Z`;
  return t;
}

export function addDays(day, n) {
  const d = new Date(`${parseDay(day)}T00:00:00.000Z`);
  return new Date(d.getTime() + Math.round(n * DAY_MS)).toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  const a = new Date(`${parseDay(from)}T00:00:00.000Z`).getTime();
  const b = new Date(`${parseDay(to)}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / DAY_MS);
}

export function addHours(iso, h) {
  return new Date(new Date(parseTime(iso)).getTime() + h * 3_600_000).toISOString();
}

export function nowIso() {
  return new Date().toISOString();
}

export function minDay(...days) {
  return days.filter(Boolean).sort()[0];
}

// 日期枚举（含端点）
export function eachDay(from, to) {
  const out = [];
  let d = parseDay(from);
  const end = parseDay(to);
  for (let i = 0; i < 4000; i += 1) {
    out.push(d);
    if (d >= end) break;
    d = addDays(d, 1);
  }
  return out;
}
