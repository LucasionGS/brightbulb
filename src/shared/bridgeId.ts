/**
 * Normalise a Hue bridge id for use as a stable key.
 *
 * Bridges report their id in two forms: the 16-character EUI-64 from
 * `/api/config` (`C42996FFFECA8B7A`) and sometimes a 12-character MAC-derived
 * one. The EUI-64 form is the MAC with `fffe` inserted in the middle, so that
 * filler is removed and both forms map to the same key (`c42996ca8b7a`).
 */
export function normalizeBridgeId(id: string): string {
  const lower = id.trim().toLowerCase();
  if (lower.length === 16 && lower.slice(6, 10) === "fffe") {
    return lower.slice(0, 6) + lower.slice(10);
  }
  return lower;
}

/**
 * Short label for a bridge, as printed under the Hue logo: the last six characters.
 */
export function bridgeDisplayName(id: string): string {
  return `Hue Bridge ${id.slice(-6).toUpperCase()}`;
}
