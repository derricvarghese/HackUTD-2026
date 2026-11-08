// Unit formatting helpers for distances and heights across the dashboard.
// User preference: 'auto' | 'metric' | 'imperial'

export type UnitsPref = 'auto' | 'metric' | 'imperial';

const STORAGE_KEY = 'beacon.units';

export function getStoredUnits(): UnitsPref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'metric' || v === 'imperial' || v === 'auto') return v;
  } catch {
    /* storage blocked */
  }
  return 'auto';
}

export function setStoredUnits(u: UnitsPref): void {
  try {
    localStorage.setItem(STORAGE_KEY, u);
  } catch {
    /* storage blocked */
  }
}

/** Detects if the user locale defaults to imperial (US, Liberia, Myanmar). */
export function isLocaleImperial(): boolean {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    const lang = nav?.language || '';
    if (/-(US|LR|MM)\b/i.test(lang)) return true;
    // Check Intl measurement system if supported
    const loc = new Intl.Locale(lang || 'en') as unknown as { measurementSystem?: string };
    if (loc.measurementSystem === 'us' || loc.measurementSystem === 'imperial') return true;
  } catch {
    /* fallback to metric */
  }
  return false;
}

export function resolveUnits(pref: UnitsPref): 'metric' | 'imperial' {
  if (pref === 'auto') {
    return isLocaleImperial() ? 'imperial' : 'metric';
  }
  return pref;
}

/**
 * Formats a distance in meters to a human string according to user preference.
 * Metric: < 1000m -> "X m", >= 1000m -> "X.X km"
 * Imperial: < 5280 ft -> "X ft", >= 1 mi -> "X.X mi"
 */
export function formatDistance(meters: number, pref: UnitsPref = 'auto'): string {
  if (meters == null || isNaN(meters)) return '-';
  const system = resolveUnits(pref);
  if (system === 'imperial') {
    const feet = meters * 3.28084;
    if (feet < 5280) {
      return `${Math.round(feet)} ft`;
    }
    const miles = meters / 1609.344;
    return `${miles >= 10 ? miles.toFixed(0) : miles.toFixed(1)} mi`;
  }
  // Metric
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  const km = meters / 1000;
  return `${km >= 10 ? km.toFixed(0) : km.toFixed(1)} km`;
}

/** Formats kilometers directly. */
export function formatKm(km: number, pref: UnitsPref = 'auto'): string {
  if (km == null || isNaN(km)) return '-';
  return formatDistance(km * 1000, pref);
}
