/** Title normalisation and candidate scoring for TMDB search results. */

export interface Candidate {
  id: number;
  title: string;
  originalTitle?: string;
  year?: number;
  popularity?: number;
}

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
}

/** Below this score a search result is rejected rather than risking a wrong match. */
export const MIN_MATCH_SCORE = 0.65;

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(the|a|an) /, '')
    .replace(/\s+/g, ' ');
}

function bigrams(s: string): Map<string, number> {
  const compact = s.replace(/\s+/g, '');
  const grams = new Map<string, number>();
  for (let i = 0; i < compact.length - 1; i++) {
    const g = compact.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  return grams;
}

/** Sørensen–Dice similarity of character bigrams, 0..1 (1 = identical after normalisation). */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of ga) {
    overlap += Math.min(n, gb.get(g) ?? 0);
    total += n;
  }
  for (const n of gb.values()) total += n;
  return total === 0 ? 0 : (2 * overlap) / total;
}

export function parseYear(date?: string | null): number | undefined {
  const m = date?.match(/^(\d{4})/);
  return m ? Number(m[1]) : undefined;
}

export function scoreCandidate(candidate: Candidate, query: { title: string; year?: number }, rank: number): number {
  const similarity = Math.max(
    titleSimilarity(query.title, candidate.title),
    candidate.originalTitle ? titleSimilarity(query.title, candidate.originalTitle) : 0,
  );

  let yearScore: number;
  if (!query.year || !candidate.year) yearScore = 0.15;
  else {
    const diff = Math.abs(query.year - candidate.year);
    yearScore = diff === 0 ? 0.3 : diff === 1 ? 0.2 : -0.2;
  }

  // TMDB already ranks by relevance; give its ordering and popularity a small say.
  const rankBonus = rank === 0 ? 0.04 : rank === 1 ? 0.02 : 0;
  const popularityBonus = Math.min((candidate.popularity ?? 0) / 200, 1) * 0.02;
  return similarity * 0.7 + yearScore + rankBonus + popularityBonus;
}

export function pickBest(candidates: Candidate[], query: { title: string; year?: number }): ScoredCandidate | null {
  let best: ScoredCandidate | null = null;
  candidates.slice(0, 15).forEach((candidate, rank) => {
    const score = scoreCandidate(candidate, query, rank);
    if (!best || score > best.score) best = { candidate, score };
  });
  return best;
}
