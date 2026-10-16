// Date.prototype.toUTCString: RFC 7231 IMF-fixdate in UTC, byte-identical to
// Node. Unlike toISOString it never throws; invalid dates answer "Invalid Date".
const stamps: number[] = [
  0, // the epoch
  1, // one ms after: the string drops milliseconds
  -1, // 23:59:59.999 the day before the epoch
  1791979200000, // 2026-10-14T12:00:00Z, the RFC 7231 example shape
  951782400000, // 2000-02-29, a leap day
  4107542400000, // 2100-03-01, 2100 is not a leap year
  -86400000, // 1969-12-31
  -2208988800000, // 1900-01-01, pre-1970
  -62167219200000, // year 0000
  -62198755200000, // negative year
  253402300799999, // the last 4-digit-year ms
  253402300800000, // the first 5-digit year
  8640000000000000, // the range maximum
  -8640000000000000, // the range minimum
  1.9, // fractional ms truncate
  -1.9,
];
for (let i = 0; i < stamps.length; i++) {
  console.log(new Date(stamps[i]!).toUTCString());
}

// Stored and passed Date values.
function fmt(d: Date): string {
  return d.toUTCString();
}
const stored = new Date(Date.UTC(2024, 1, 29, 23, 59, 59));
console.log(fmt(stored), stored.toUTCString().length);

// Invalid dates never throw here.
console.log(new Date(0 / 0).toUTCString());
console.log(new Date(8640000000000001).toUTCString());
console.log(new Date("not a date").toUTCString());

// Every weekday and month name over one 2023 week/year walk.
for (let m = 0; m < 12; m++) {
  console.log(new Date(Date.UTC(2023, m, 1 + m)).toUTCString());
}
