import { similarity, vecOf, scarcity, CRED_FLOOR } from "./metrics.js";
import type { Fit, Lab, PortfolioPick, Profile } from "./types.js";

/**
 * A ranked list is the wrong deliverable. You do not apply to "the best lab";
 * you send N applications and want the best *set* of N.
 *
 * The top five of a ranked list are usually near-duplicates of each other,
 * which means five shots at the same target: one funding climate turning, or
 * one systematic reason you are a poor fit, takes out all five at once.
 *
 * Maximal marginal relevance picks greedily on
 *
 *     lambda * quality  -  (1 - lambda) * redundancy-with-what-is-already-picked
 *
 * lambda = 1 reproduces the plain ranking. Lower values buy diversification at
 * the cost of individual fit. This is a standard, well-understood trade-off,
 * not a bespoke heuristic.
 */
export function portfolio(
  me: Profile,
  labs: Lab[],
  vocab: string[],
  fits: Fit[],
  k = 5,
  lambda = 0.65,
  minFoundation = CRED_FLOOR,
): PortfolioPick[] {
  const byId = new Map(labs.map((l) => [l.id, l]));
  const fitById = new Map(fits.map((f) => [f.labId, f]));
  const sc = scarcity(labs, vocab);

  // Only labs where you are credible enough to be read at all.
  const pool = fits.filter((f) => f.foundation >= minFoundation);
  if (!pool.length) return [];

  const maxScore = Math.max(...pool.map((f) => f.score)) || 1;
  const picked: PortfolioPick[] = [];
  const covered = new Set<string>();
  const remaining = new Set(pool.map((f) => f.labId));

  while (picked.length < k && remaining.size) {
    let bestId: string | null = null;
    let bestVal = -Infinity;

    for (const id of remaining) {
      const f = fitById.get(id)!;
      const lab = byId.get(id)!;
      const quality = f.score / maxScore;
      const redundancy = picked.length
        ? Math.max(...picked.map((p) => similarity(byId.get(p.labId)!, lab).sim))
        : 0;
      const val = lambda * quality - (1 - lambda) * redundancy;
      if (val > bestVal) { bestVal = val; bestId = id; }
    }
    if (!bestId) break;

    const lab = byId.get(bestId)!;
    const vl = vecOf(lab);
    const unique: string[] = [];
    for (const t of me.topics) {
      // Topics this lab engages that no earlier pick did.
      if ((vl.get(t.label) ?? 0) >= 0.3 && !covered.has(t.label)) {
        unique.push(t.label);
        covered.add(t.label);
      }
    }
    unique.sort((a, b) => (sc.idf.get(b) ?? 1) - (sc.idf.get(a) ?? 1));

    picked.push({ labId: bestId, fit: fitById.get(bestId)!, marginal: bestVal, uniqueCoverage: unique });
    remaining.delete(bestId);
  }
  return picked;
}
