import type {
  AssetRow, Edge, Entity, Fit, Lab, LabMetrics, Profile, RiskFlag, Similarity, Topic, Transfer,
} from "./types.js";

export const CRED_FLOOR = 0.15;

/**
 * How much a topic still counts toward Foundation once the person says they
 * are done with it. Not zero: the work happened, the credibility is real, and
 * a PI reading the CV will see it. Not one either, or a side project from
 * years ago keeps steering the ranking toward labs they no longer want.
 */
export const PURSUIT_FLOOR = 0.3;

export const pursuitOf = (t: Topic): number =>
  t.pursuit === undefined ? 1 : Math.max(0, Math.min(1, t.pursuit));

/** The person as their appetite rather than their history. Foundation only. */
const asPursued = (me: Profile): Entity => ({
  topics: me.topics.map((t) => ({ ...t, weight: t.weight * (PURSUIT_FLOOR + (1 - PURSUIT_FLOOR) * pursuitOf(t)) })),
});

export const vecOf = (e: Entity): Map<string, number> =>
  new Map(e.topics.map((t) => [t.label, Math.max(0, Math.min(1, t.weight))]));

/** Weighted cosine over shared topic labels. */
export function similarity(a: Entity, b: Entity): Similarity {
  const va = vecOf(a), vb = vecOf(b);
  let dot = 0;
  const shared: Similarity["shared"] = [];
  for (const [k, w] of va) {
    const o = vb.get(k);
    if (o !== undefined) { dot += w * o; shared.push({ label: k, wa: w, wb: o }); }
  }
  if (!dot) return { sim: 0, shared: [] };
  let na = 0, nb = 0;
  for (const w of va.values()) na += w * w;
  for (const w of vb.values()) nb += w * w;
  shared.sort((x, y) => y.wa * y.wb - x.wa * x.wb);
  return { sim: dot / Math.sqrt(na * nb), shared };
}

export function edges(labs: Lab[]): Edge[] {
  const out: Edge[] = [];
  for (let i = 0; i < labs.length; i++)
    for (let j = i + 1; j < labs.length; j++) {
      const r = similarity(labs[i], labs[j]);
      if (r.sim > 0.001) out.push({ a: labs[i].id, b: labs[j].id, ...r });
    }
  return out;
}

/**
 * How rare each topic is across this specific network.
 *
 * This is why a network beats a one-lab comparison: a skill 12 of 15 labs
 * already have is table stakes, not leverage, and only the network knows that.
 */
export interface Scarcity { n: number; df: Map<string, number>; idf: Map<string, number>; }

export function scarcity(labs: Lab[], vocab: string[]): Scarcity {
  const n = labs.length;
  const df = new Map<string, number>();
  for (const p of labs) for (const t of p.topics) df.set(t.label, (df.get(t.label) ?? 0) + 1);
  const denom = Math.log(1 + n) || 1;
  const idf = new Map<string, number>();
  for (const t of vocab) idf.set(t, Math.log(1 + n / (1 + (df.get(t) ?? 0))) / denom);
  return { n, df, idf };
}

/* ────────────────────────────────────────────────────────────────
   Structure of the lab network itself
   ──────────────────────────────────────────────────────────────── */

/** Shannon entropy of the weight distribution, inverted: 1 = one topic dominates. */
export function focus(t: Topic[]): number {
  if (t.length <= 1) return 1;
  const total = t.reduce((s, x) => s + x.weight, 0);
  if (!total) return 0;
  let h = 0;
  for (const x of t) { const p = x.weight / total; if (p > 0) h -= p * Math.log(p); }
  return 1 - h / Math.log(t.length);
}

/** Emerging weight minus legacy weight. Null when the extraction tagged nothing. */
export function momentum(t: Topic[]): number | null {
  if (!t.some((x) => x.recency && x.recency !== "core")) return null;
  const total = t.reduce((s, x) => s + x.weight, 0) || 1;
  let e = 0, l = 0;
  for (const x of t) {
    if (x.recency === "emerging") e += x.weight;
    else if (x.recency === "legacy") l += x.weight;
  }
  return (e - l) / total;
}

/** Connected components at the given link threshold. */
export function clusters(labs: Lab[], es: Edge[], threshold: number): Map<string, number> {
  const parent = new Map(labs.map((l) => [l.id, l.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; }
    return r;
  };
  for (const e of es) if (e.sim >= threshold) parent.set(find(e.a), find(e.b));
  const roots = new Map<string, number>();
  const out = new Map<string, number>();
  for (const l of labs) {
    const r = find(l.id);
    if (!roots.has(r)) roots.set(r, roots.size);
    out.set(l.id, roots.get(r)!);
  }
  return out;
}

export function labMetrics(labs: Lab[], threshold: number): Map<string, LabMetrics> {
  const es = edges(labs);
  const cl = clusters(labs, es, threshold);
  const deg = new Map<string, number>(labs.map((l) => [l.id, 0]));
  for (const e of es) if (e.sim >= threshold) {
    deg.set(e.a, deg.get(e.a)! + 1);
    deg.set(e.b, deg.get(e.b)! + 1);
  }
  const maxDeg = Math.max(1, labs.length - 1);
  const out = new Map<string, LabMetrics>();
  for (const l of labs) out.set(l.id, {
    id: l.id,
    focus: focus(l.topics),
    centrality: deg.get(l.id)! / maxDeg,
    momentum: momentum(l.topics),
    cluster: cl.get(l.id)!,
  });
  return out;
}

/* ────────────────────────────────────────────────────────────────
   Fit — three axes, because one score hides which is carrying it
   ──────────────────────────────────────────────────────────────── */

export interface Weights { foundation: number; leverage: number; growth: number; direction: number; }
export const DEFAULT_WEIGHTS: Weights = { foundation: 0.32, leverage: 0.28, growth: 0.16, direction: 0.24 };

/**
 * How much of the lab's programme lies where the person said they are heading.
 *
 * Growth on its own is blind to intent: a lab with twenty topics you lack
 * scores high even when none of them interest you. That is exactly what a
 * broad publication record does to a ranking. Direction is the correction.
 *
 * Null when no aspiration was stated, so it can be dropped rather than faked.
 */
export function direction(lab: Lab, aspiration: Topic[]): number | null {
  if (!aspiration.length) return null;
  const asp = new Map(aspiration.map((t) => [t.label, Math.max(0, Math.min(1, t.weight))]));
  let num = 0, den = 0;
  for (const t of lab.topics) { den += t.weight; num += t.weight * (asp.get(t.label) ?? 0); }
  return den ? num / den : 0;
}

const PORTABLE = new Set(["method", "theory"]);
const APPLIED = new Set(["system", "application"]);

/**
 * What carries across when the person is changing field.
 *
 * A technique you already own is portable; a system you have never worked in
 * is where it would go. Requiring both is why this is a geometric mean —
 * having methods with nowhere new to apply them is not a pivot, and a new
 * field you bring nothing to is not a transfer, it is starting over.
 */
export function transfer(me: Profile, lab: Lab): Transfer {
  const vm = vecOf(me), vl = vecOf(lab);
  let pNum = 0, pDen = 0;
  const portable: Transfer["portable"] = [];
  for (const t of me.topics) {
    if (!PORTABLE.has(t.category)) continue;
    pDen += t.weight;
    if ((vl.get(t.label) ?? 0) < 0.2) { pNum += t.weight; portable.push({ label: t.label, weight: t.weight }); }
  }
  let tNum = 0, tDen = 0;
  const targets: Transfer["targets"] = [];
  for (const t of lab.topics) {
    if (!APPLIED.has(t.category)) continue;
    tDen += t.weight;
    if ((vm.get(t.label) ?? 0) < 0.2) { tNum += t.weight; targets.push({ label: t.label, weight: t.weight }); }
  }
  portable.sort((a, b) => b.weight - a.weight);
  targets.sort((a, b) => b.weight - a.weight);
  const p = pDen ? pNum / pDen : 0;
  const t = tDen ? tNum / tDen : 0;
  return { portable, targets, score: Math.sqrt(p * t) };
}

export function fitFor(
  me: Profile, lab: Lab, sc: Scarcity, lm: LabMetrics | undefined, w: Weights,
): Fit {
  const vm = vecOf(me), vl = vecOf(lab);
  // Foundation runs on pursued weights; Leverage and Transfer run on full ones,
  // because a technique stays portable whether or not you want to keep using it.
  const { sim: foundation, shared } = similarity(asPursued(me), lab);
  const retiredOverlap = me.topics
    .filter((t) => pursuitOf(t) < 0.5 && (vl.get(t.label) ?? 0) >= 0.2)
    .map((t) => ({ label: t.label, weight: t.weight, pursuit: pursuitOf(t) }))
    .sort((a, b) => b.weight - a.weight);

  let lNum = 0, lDen = 0;
  const missing: Fit["missing"] = [];
  for (const [t, weight] of vm) {
    const idf = sc.idf.get(t) ?? 1;
    const have = vl.get(t) ?? 0;
    lDen += weight * idf;
    lNum += weight * idf * (1 - have);
    if (have < 0.2) missing.push({ label: t, weight, idf, df: sc.df.get(t) ?? 0 });
  }
  const leverageRaw = lDen ? lNum / lDen : 0;

  // A lab you share nothing with must not score well on "what you'd add" —
  // you would never get the interview to add it.
  const gate = Math.min(1, foundation / CRED_FLOOR);
  const leverage = leverageRaw * gate;

  let gNum = 0, gDen = 0;
  const learn: Fit["learn"] = [];
  for (const [t, weight] of vl) {
    const have = vm.get(t) ?? 0;
    gDen += weight;
    gNum += weight * (1 - have);
    if (have < 0.2) learn.push({ label: t, weight });
  }
  const growth = gDen ? gNum / gDen : 0;

  missing.sort((a, b) => b.weight * b.idf - a.weight * a.idf);
  learn.sort((a, b) => b.weight - a.weight);

  const dir = direction(lab, me.aspiration);
  const tr = transfer(me, lab);

  // With no stated direction its weight is dropped rather than imputed, so the
  // index stays comparable instead of silently crediting an unknown.
  const wDir = dir === null ? 0 : w.direction;
  const wsum = w.foundation + w.leverage + w.growth + wDir || 1;
  const score = (100 * (w.foundation * foundation + w.leverage * leverage
    + w.growth * growth + wDir * (dir ?? 0))) / wsum;

  const risks: RiskFlag[] = [];
  if (foundation < CRED_FLOOR) risks.push("thin-foundation");
  if (leverageRaw < 0.25) risks.push("redundant");
  if (growth < 0.25) risks.push("nothing-to-learn");
  if (lm && lm.centrality === 0 && sc.n > 2) risks.push("isolated");
  if (lm && lm.momentum !== null && lm.momentum < -0.2) risks.push("declining");
  if (dir !== null && dir < 0.2 && growth > 0.5) risks.push("off-direction");
  if (foundation < 0.25 && tr.score < 0.2) risks.push("no-bridge");
  if (retiredOverlap.length && shared.length && retiredOverlap.length >= shared.length * 0.6)
    risks.push("past-self");

  return {
    labId: lab.id, foundation, leverage, leverageRaw, gate, growth,
    direction: dir, transfer: tr, score, shared, missing, learn, retiredOverlap, risks,
  };
}

export function ranking(me: Profile, labs: Lab[], vocab: string[], threshold: number, w: Weights): Fit[] {
  const sc = scarcity(labs, vocab);
  const lm = labMetrics(labs, threshold);
  return labs.map((l) => fitFor(me, l, sc, lm.get(l.id), w)).sort((a, b) => b.score - a.score);
}

/* ────────────────────────────────────────────────────────────────
   Profile-level diagnostics
   ──────────────────────────────────────────────────────────────── */

/** Aspiration topics that no lab on the map works on. */
export function unmetAspiration(me: Profile, labs: Lab[]): Topic[] {
  const held = new Set(labs.flatMap((l) => l.topics.filter((t) => t.weight >= 0.3).map((t) => t.label)));
  return me.aspiration.filter((t) => !held.has(t.label)).sort((a, b) => b.weight - a.weight);
}

export function assetAnalysis(me: Profile, labs: Lab[], vocab: string[]) {
  const sc = scarcity(labs, vocab);
  const rows: AssetRow[] = me.topics
    .map((t) => {
      const idf = sc.idf.get(t.label) ?? 1;
      const df = sc.df.get(t.label) ?? 0;
      return { label: t.label, category: t.category, weight: t.weight, df, idf, value: t.weight * idf };
    })
    .sort((a, b) => b.value - a.value);
  const n = sc.n;
  return {
    n,
    rows,
    scarce: rows.filter((r) => r.df > 0 && r.df <= Math.max(1, Math.ceil(n * 0.3))),
    common: n >= 3 ? rows.filter((r) => r.df >= Math.ceil(n * 0.7)) : [],
    absent: rows.filter((r) => r.df === 0),
  };
}

/** Fraction of your idf-weighted profile that at least one lab in the shortlist uses. */
export function coverage(me: Profile, labs: Lab[], vocab: string[]): number {
  const sc = scarcity(labs, vocab);
  let num = 0, den = 0;
  for (const t of me.topics) {
    const idf = sc.idf.get(t.label) ?? 1;
    den += t.weight * idf;
    const best = Math.max(0, ...labs.map((l) => vecOf(l).get(t.label) ?? 0));
    num += t.weight * idf * Math.min(1, best / 0.3);
  }
  return den ? Math.min(1, num / den) : 0;
}

/** Pairs of labs that don't connect to each other, but both connect to you. */
export function brokerage(me: Profile, labs: Lab[], threshold: number) {
  if (labs.length < 2) return { bridges: [] as { a: string; b: string; strength: number }[], count: 0 };
  const linked = new Set(edges(labs).filter((e) => e.sim >= threshold).map((e) => e.a + "|" + e.b));
  const mine = new Map(labs.map((l) => [l.id, similarity(me, l).sim]));
  const bridges: { a: string; b: string; strength: number }[] = [];
  for (let i = 0; i < labs.length; i++)
    for (let j = i + 1; j < labs.length; j++) {
      const A = labs[i], B = labs[j];
      if (linked.has(A.id + "|" + B.id)) continue;
      const sa = mine.get(A.id)!, sb = mine.get(B.id)!;
      if (sa >= threshold && sb >= threshold)
        bridges.push({ a: A.name, b: B.name, strength: Math.min(sa, sb) });
    }
  bridges.sort((x, y) => y.strength - x.strength);
  return { bridges, count: bridges.length };
}

/** Mean pairwise similarity among your top picks. High means correlated risk. */
export function concentration(top: Lab[]) {
  if (top.length < 3) return null;
  let sum = 0, n = 0;
  for (let i = 0; i < top.length; i++)
    for (let j = i + 1; j < top.length; j++) { sum += similarity(top[i], top[j]).sim; n++; }
  return { mean: n ? sum / n : 0, labs: top.map((l) => l.name) };
}
