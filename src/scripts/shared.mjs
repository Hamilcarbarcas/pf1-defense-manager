/* Shared between the defense engine and the temp HP engine. */

export const MODULE_ID = "pf1-defense-manager";

export function getItemDefenses(item) {
  const raw = item.getFlag(MODULE_ID, "defenses");
  if (!raw) return [];
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return []; }
  }
  // Legacy: migrate old array/object format
  return Array.isArray(raw) ? [...raw] : Object.values(raw);
}

/** Entries predating the `enabled` field have no such key and are live. */
export function isEntryEnabled(entry) {
  return entry?.enabled !== false;
}
