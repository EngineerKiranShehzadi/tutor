// The one CSV writer for admin exports. Every cell is quoted with embedded
// quotes doubled, and a cell that starts with = + - @ tab or CR gets a leading
// apostrophe, so Excel / Sheets show it as text instead of running it as a
// formula (CSV / formula injection). Names, e-mails and questions are typed by
// students, so they must never be trusted as cells.

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}

// UTF-8 BOM so Excel reads non-ASCII names (e.g. Urdu) correctly.
export function downloadCsv(filename: string, rows: unknown[][]): void {
  const url = URL.createObjectURL(new Blob(['﻿', toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
