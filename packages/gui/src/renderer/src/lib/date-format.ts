/** Format a Date as MM-DD HH:mm, with optional year prefix if different from current year. */
export function formatDateCompact(date: Date, includeYear?: boolean): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  if (includeYear && date.getFullYear() !== new Date().getFullYear()) {
    return `${date.getFullYear()}-${mm}-${dd} ${hh}:${min}`;
  }
  return `${mm}-${dd} ${hh}:${min}`;
}

/** Format a Date as ISO-like YYYY-MM-DDTHH:mm:00 for API submission. */
export function formatDateISO(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}:00`;
}
