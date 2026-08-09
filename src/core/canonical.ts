const STOP = new Set([
  "of", "the", "and", "in", "for", "a", "on", "to", "with", "using", "from",
]);

/** Crude stemming, enough to make "models"/"model" and "studies"/"study" agree. */
export function tokens(s: string): Set<string> {
  const words = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/);
  const out = new Set<string>();
  for (const w of words) {
    if (!w || STOP.has(w)) continue;
    let t = w;
    if (t.endsWith("ies") && t.length > 4) t = t.slice(0, -3) + "y";
    else if (t.endsWith("s") && !t.endsWith("ss") && t.length > 3) t = t.slice(0, -1);
    out.add(t);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/** Character bigrams of a string, whitespace collapsed. */
function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice over character bigrams. */
export function dice(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export const SNAP_THRESHOLD = 0.6;

/**
 * Character-level backstop for morphological variants that token overlap
 * misses: viral/virus, genome/genomic, structure/structural.
 *
 * Guarded by a token floor so it cannot merge two labels that merely share a
 * long common word — "protein language models" and "protein structure
 * prediction" have similar spelling and must stay apart.
 */
export const DICE_THRESHOLD = 0.75;
export const DICE_TOKEN_FLOOR = 0.3;

/**
 * One label's tokens contained in the other's: the same concept written at two
 * grains. "protein sequence design" is "protein design" with a qualifier.
 *
 * Requires at least two shared tokens, so "cell biology" does not swallow
 * "single cell rnaseq" on the strength of one common word.
 */
export function subsumes(a: string, b: string): boolean {
  const A = tokens(a), B = tokens(b);
  const small = A.size <= B.size ? A : B;
  const big = A.size <= B.size ? B : A;
  if (small.size < 2 || big.size <= small.size) return false;
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

export function sameConcept(a: string, b: string): boolean {
  const j = jaccard(tokens(a), tokens(b));
  if (j >= SNAP_THRESHOLD) return true;
  if (j >= DICE_TOKEN_FLOOR && dice(a, b) >= DICE_THRESHOLD) return true;
  return subsumes(a, b);
}

/**
 * Snap a freshly extracted label onto an existing vocabulary entry when they
 * name the same concept.
 *
 * Without this, one lab gets "viral evolution", the next gets "virus
 * evolution", and they never link. The graph looks fine and is wrong. This is
 * the single highest-leverage function in the codebase.
 *
 * Mutates `vocab`, appending genuinely new labels.
 */
export function canonicalise(label: string, vocab: string[]): string {
  const norm = String(label).toLowerCase().trim().replace(/\s+/g, " ");
  if (!norm) return norm;
  if (vocab.includes(norm)) return norm;

  const tk = tokens(norm);
  let best: string | null = null;
  let bestScore = 0;
  for (const v of vocab) {
    if (!sameConcept(norm, v)) continue;
    // Among acceptable matches prefer the closest, and break ties toward the
    // shorter label — the more general one is the one other labs will reach for.
    const s = Math.max(jaccard(tk, tokens(v)), dice(norm, v)) + (v.length < norm.length ? 0.01 : 0);
    if (s > bestScore) { bestScore = s; best = v; }
  }
  if (best) return best;
  vocab.push(norm);
  return norm;
}

/** Rebuild the vocabulary from whatever entities still exist. */
export function pruneVocab(vocab: string[], entities: { topics: { label: string }[] }[]): string[] {
  const live = new Set(entities.flatMap((e) => e.topics.map((t) => t.label)));
  return vocab.filter((v) => live.has(v));
}
