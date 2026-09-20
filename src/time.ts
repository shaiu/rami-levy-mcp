// Rami Levy's order `created_at` has been seen in two shapes, and this server
// records its own sync times as UTC instants, so both have to land on a UTC
// instant to be comparable:
//
//   - Zoned ISO-8601 ("2026-09-08T05:59:37.000000Z") — what the live API
//     returns as of 2026-09-20. Taken at its word; no conversion.
//   - A naive wall-clock string in Israel time ("2026-09-08 10:15:00", no
//     offset). Converted here using the real Asia/Jerusalem rules from Intl,
//     never a fixed offset: Israel is UTC+2 in winter and UTC+3 in summer.
//
// Keep the naive branch: it is what makes this safe if the API reverts to
// offset-less strings, not dead code to tidy away.
//
// Ambiguity: when the clocks fall back in late October, one local hour
// happens twice; a time inside it resolves to one of its two readings, so an
// order placed in that hour can be misjudged by up to an hour. A time inside
// the spring-forward gap (which never happens on the wall clock) resolves to
// a nearby instant. Both are an hour a year at night; accepted.

const JERUSALEM = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Jerusalem',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

// How far Jerusalem wall-clock time is ahead of UTC at the given instant.
function jerusalemOffsetMs(utcMs: number): number {
  const parts: Record<string, number> = {};
  for (const p of JERUSALEM.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000;
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

// Returns the UTC instant (ms since epoch) of an Israel-local timestamp, or
// null if the string isn't a recognisable date-time. A string that already
// carries an explicit zone (Z or ±hh:mm) is taken at its word.
export function jerusalemLocalToUtcMs(local: string): number | null {
  const s = local.trim();
  const m = NAIVE.exec(s);
  if (!m) {
    if (!HAS_ZONE.test(s)) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // Reject what Date.UTC would silently roll over (month 13, Feb 30, 25:00).
  const check = new Date(wallAsUtc);
  if (
    check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
    check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second
  ) {
    return null;
  }
  // Two passes: the offset guessed at the wall time read as UTC can be on the
  // wrong side of a DST switch; re-reading it at the corrected instant fixes that.
  const first = wallAsUtc - jerusalemOffsetMs(wallAsUtc);
  return wallAsUtc - jerusalemOffsetMs(first);
}
