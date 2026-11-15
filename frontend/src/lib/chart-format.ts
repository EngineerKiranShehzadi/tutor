// Shared formatting for the Observability pages, so every tab labels its
// axes and its timestamps the same way.

// One timestamp format for every table on every tab. Traces printed
// "Nov 14, 09:58:56 PM", Spans printed "9:58:53 PM" with no date at all, and
// Sessions and Errors printed "11/14/2026, 9:58:53 PM".
export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// A six-figure token total printed in full is wider than the axis, and the
// leading digit was being cut off. 1.2M / 480k fits.
export function fmtAxisNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

// Buckets are five minutes, an hour or a whole day wide depending on how long
// the range is (bucketWidthMs, backend). Printing only the clock time labelled
// five consecutive days as "05:00 AM", so the label follows the bucket width
// the data actually came back with.
export function bucketTickFormatter(series: { bucket: string }[]): (value: string) => string {
  const times = series.map(s => new Date(s.bucket).getTime()).sort((a, b) => a - b);
  let smallestGap = Infinity;
  for (let i = 1; i < times.length; i++) smallestGap = Math.min(smallestGap, times[i] - times[i - 1]);
  const dayWide = smallestGap >= 23 * 3_600_000;
  return (value: string) => {
    const d = new Date(value);
    return dayWide
      ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };
}
