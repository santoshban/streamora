import type { Profile } from '../db/schema.js';

/**
 * Certifications shown on kids profiles. Unrated titles are hidden from kids:
 * an unmatched home video is more likely to be unsuitable than not.
 */
const KIDS_RATINGS = new Set([
  // US film / TV
  'G', 'PG', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG',
  // UK, India, Ireland, Australia, New Zealand
  'U', 'UC', 'U/A 7+', 'UA 7+', 'UA7+', 'C',
  // France, Netherlands, Germany, Spain, Brazil...
  'TP', 'TOUS PUBLICS', 'AL', 'ALL', 'L', 'APTA', 'FSK 0', 'FSK 6', 'TODOS',
]);

export function isKidsRating(rating: string | null | undefined): boolean {
  if (!rating) return false;
  const value = rating.trim().toUpperCase();
  if (KIDS_RATINGS.has(value)) return true;
  const age = /^(?:FSK\s*|PEGI\s*)?(\d{1,2})\s*\+?$/.exec(value);
  return !!age && Number(age[1]) <= 10;
}

/** Whether a profile may see/play an item. */
export function canAccess(profile: Pick<Profile, 'isKids'>, item: { contentRating: string | null }): boolean {
  return !profile.isKids || isKidsRating(item.contentRating);
}
