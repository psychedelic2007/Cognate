import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalise, jaccard, tokens } from "./canonical.js";
import {
  similarity, scarcity, fitFor, ranking, focus, momentum, clusters, edges,
  labMetrics, brokerage, concentration, coverage, direction, transfer,
  unmetAspiration, DEFAULT_WEIGHTS, CRED_FLOOR,
} from "./metrics.js";
import { portfolio } from "./portfolio.js";
import type { Lab, Profile, Topic } from "./types.js";

const T = (label: string, weight: number, extra: Partial<Topic> = {}): Topic =>
  ({ label, weight, category: "method", ...extra });

const lab = (id: string, name: string, topics: Topic[]): Lab =>
  ({ id, name, institution: "X", summary: "", topics, sources: [], addedAt: "" });

// Categories are real here: transfer and direction both read them, so a
// fixture where everything defaults to "method" tests nothing.
const M = (l: string, w: number) => T(l, w, { category: "method" });
const TH = (l: string, w: number) => T(l, w, { category: "theory" });
const SY = (l: string, w: number) => T(l, w, { category: "system" });
const AP = (l: string, w: number) => T(l, w, { category: "application" });

const NET: Lab[] = [
  lab("a", "PLM-A", [M("protein language models", 1), TH("viral evolution", .9), AP("antibody escape", .8), SY("sars cov 2", .7)]),
  lab("b", "PLM-B", [M("protein language models", 1), TH("viral evolution", .8), M("variant effect prediction", .9), SY("sars cov 2", .6)]),
  lab("c", "PLM-C", [M("protein language models", .9), AP("antibody escape", .9), SY("influenza", .8)]),
  lab("d", "Clearance-D", [SY("glymphatic clearance", 1), TH("compartmental modelling", .9), SY("amyloid beta", .8)]),
];
const VOCAB = [...new Set(NET.flatMap((l) => l.topics.map((t) => t.label)))];

const profile = (topics: Topic[], aspiration: Topic[] = []): Profile =>
  ({ name: "Me", stage: "phd", headline: "", topics, assets: [], source: "cv.pdf",
     aspiration, aspirationNote: aspiration.length ? "stated" : "" });

/* ── canonicalisation ────────────────────────────────────────── */

test("synonyms snap to one label so the graph stays connected", () => {
  const vocab = ["viral evolution"];
  assert.equal(canonicalise("virus evolution", vocab), "viral evolution");
  assert.equal(canonicalise("Viral Evolution", vocab), "viral evolution");
  assert.equal(vocab.length, 1, "no synonym should have been appended");
});

test("genuinely different concepts are not merged", () => {
  const vocab = ["viral evolution"];
  assert.equal(canonicalise("glymphatic clearance", vocab), "glymphatic clearance");
  assert.equal(vocab.length, 2);
});

test("plural stemming is conservative", () => {
  assert.ok(jaccard(tokens("protein language models"), tokens("protein language model")) === 1);
  assert.ok(jaccard(tokens("mass"), tokens("ma")) < 1, "must not strip -ss");
});

/* ── similarity ──────────────────────────────────────────────── */

test("identical vectors give similarity 1, disjoint give 0", () => {
  assert.equal(similarity(NET[0], NET[0]).sim, 1);
  assert.equal(similarity(NET[0], NET[3]).sim, 0);
});

test("similarity is symmetric", () => {
  assert.ok(Math.abs(similarity(NET[0], NET[1]).sim - similarity(NET[1], NET[0]).sim) < 1e-12);
});

/* ── scarcity ────────────────────────────────────────────────── */

test("a skill most labs have scores lower than one only a single lab has", () => {
  const sc = scarcity(NET, VOCAB);
  assert.equal(sc.df.get("protein language models"), 3);
  assert.equal(sc.df.get("compartmental modelling"), 1);
  assert.ok(sc.idf.get("compartmental modelling")! > sc.idf.get("protein language models")!);
});

/* ── the central claim: overlap alone is the wrong objective ──── */

test("a candidate who merely duplicates a lab scores high foundation but low leverage", () => {
  const clone = profile([T("protein language models", 1), T("viral evolution", .9), T("sars cov 2", .8)]);
  const sc = scarcity(NET, VOCAB);
  const lm = labMetrics(NET, 0.12);
  const f = fitFor(clone, NET[0], sc, lm.get("a"), DEFAULT_WEIGHTS);
  assert.ok(f.foundation > 0.8, `expected high foundation, got ${f.foundation}`);
  assert.ok(f.leverage < 0.25, `expected low leverage, got ${f.leverage}`);
  assert.ok(f.risks.includes("redundant"));
});

test("a hybrid candidate beats a pure clone on the same lab", () => {
  const clone = profile([T("protein language models", 1), T("viral evolution", .9), T("sars cov 2", .8)]);
  const hybrid = profile([T("protein language models", .8), T("viral evolution", .7), T("compartmental modelling", .9)]);
  const sc = scarcity(NET, VOCAB), lm = labMetrics(NET, 0.12);
  const fc = fitFor(clone, NET[0], sc, lm.get("a"), DEFAULT_WEIGHTS);
  const fh = fitFor(hybrid, NET[0], sc, lm.get("a"), DEFAULT_WEIGHTS);
  assert.ok(fh.score > fc.score, `hybrid ${fh.score.toFixed(1)} should beat clone ${fc.score.toFixed(1)}`);
  assert.ok(fh.foundation < fc.foundation, "and it should win despite LOWER raw overlap");
});

test("zero overlap cannot manufacture leverage", () => {
  const alien = profile([T("stellar spectroscopy", 1)]);
  const sc = scarcity(NET, VOCAB), lm = labMetrics(NET, 0.12);
  const f = fitFor(alien, NET[0], sc, lm.get("a"), DEFAULT_WEIGHTS);
  assert.equal(f.foundation, 0);
  assert.equal(f.leverage, 0, "the credibility gate must zero this out");
  assert.ok(f.leverageRaw > 0.9, "raw leverage is high, which is exactly why the gate exists");
  assert.ok(f.risks.includes("thin-foundation"));
});

test("weights are honoured", () => {
  const me = profile([T("protein language models", .8), T("compartmental modelling", .9)]);
  const onlyGrowth = ranking(me, NET, VOCAB, 0.12, { foundation: 0, leverage: 0, growth: 1, direction: 0 });
  const onlyFound = ranking(me, NET, VOCAB, 0.12, { foundation: 1, leverage: 0, growth: 0, direction: 0 });
  assert.notEqual(onlyGrowth[0].labId, onlyFound[0].labId, "different objectives should pick different labs");
});

/* ── network structure ───────────────────────────────────────── */

test("focus separates a one-topic lab from an evenly spread one", () => {
  assert.equal(focus([T("x", 1)]), 1);
  const even = focus([T("a", 1), T("b", 1), T("c", 1)]);
  const peaked = focus([T("a", 1), T("b", .05), T("c", .05)]);
  assert.ok(even < 0.01, `evenly spread should be ~0, got ${even}`);
  assert.ok(peaked > even);
});

test("momentum is null unless the extraction tagged recency", () => {
  assert.equal(momentum([T("a", 1), T("b", 1)]), null);
  const m = momentum([T("a", 1, { recency: "emerging" }), T("b", 1, { recency: "legacy" })]);
  assert.equal(m, 0);
  assert.ok(momentum([T("a", 1, { recency: "emerging" }), T("b", .2, { recency: "core" })])! > 0.5);
});

test("clusters separate the disconnected clearance lab from the PLM cluster", () => {
  const cl = clusters(NET, edges(NET), 0.12);
  assert.equal(cl.get("a"), cl.get("b"));
  assert.equal(cl.get("a"), cl.get("c"));
  assert.notEqual(cl.get("a"), cl.get("d"));
});

test("centrality marks the isolated lab", () => {
  const lm = labMetrics(NET, 0.12);
  assert.equal(lm.get("d")!.centrality, 0);
  assert.ok(lm.get("a")!.centrality > 0);
});

/* ── diagnostics ─────────────────────────────────────────────── */

test("a candidate spanning both clusters is detected as a bridge", () => {
  const hybrid = profile([T("protein language models", .8), T("viral evolution", .7), T("compartmental modelling", .9), T("glymphatic clearance", .6)]);
  const b = brokerage(hybrid, NET, 0.12);
  assert.ok(b.count > 0, "should bridge the PLM cluster to the clearance lab");
  const clone = profile([T("protein language models", 1), T("viral evolution", .9)]);
  assert.equal(brokerage(clone, NET, 0.12).count, 0, "a pure PLM candidate bridges nothing");
});

test("concentration is higher for a shortlist of near-duplicates", () => {
  const tight = concentration([NET[0], NET[1], NET[2]])!;
  const mixed = concentration([NET[0], NET[2], NET[3]])!;
  assert.ok(tight.mean > mixed.mean);
});

test("coverage falls when the shortlist ignores half your profile", () => {
  const hybrid = profile([T("protein language models", 1), T("compartmental modelling", 1)]);
  const plmOnly = coverage(hybrid, [NET[0], NET[1], NET[2]], VOCAB);
  const both = coverage(hybrid, NET, VOCAB);
  assert.ok(both > plmOnly, `${both.toFixed(2)} should exceed ${plmOnly.toFixed(2)}`);
});

/* ── portfolio ───────────────────────────────────────────────── */

test("lambda=1 reproduces the plain ranking, lower lambda diversifies", () => {
  const me = profile([T("protein language models", .9), T("viral evolution", .8), T("compartmental modelling", .7)]);
  const fits = ranking(me, NET, VOCAB, 0.12, DEFAULT_WEIGHTS);
  const greedy = portfolio(me, NET, VOCAB, fits, 3, 1.0);
  assert.deepEqual(greedy.map((p) => p.labId), fits.slice(0, 3).map((f) => f.labId));

  const diverse = portfolio(me, NET, VOCAB, fits, 3, 0.2);
  const meanSim = (ids: string[]) => {
    const ls = ids.map((i) => NET.find((l) => l.id === i)!);
    let s = 0, n = 0;
    for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) { s += similarity(ls[i], ls[j]).sim; n++; }
    return s / n;
  };
  assert.ok(meanSim(diverse.map((p) => p.labId)) <= meanSim(greedy.map((p) => p.labId)),
    "diversified picks must not be more redundant than greedy ones");
});

test("portfolio excludes labs below the credibility floor", () => {
  const narrow = profile([T("protein language models", 1)]);
  const fits = ranking(narrow, NET, VOCAB, 0.12, DEFAULT_WEIGHTS);
  const picks = portfolio(narrow, NET, VOCAB, fits, 5, 0.65);
  assert.ok(!picks.some((p) => p.labId === "d"), "clearance lab shares nothing and must be excluded");
  assert.ok(picks.every((p) => p.fit.foundation >= CRED_FLOOR));
});

test("unique coverage is not double counted", () => {
  const me = profile([T("protein language models", .9), T("antibody escape", .8), T("compartmental modelling", .7)]);
  const fits = ranking(me, NET, VOCAB, 0.12, DEFAULT_WEIGHTS);
  const picks = portfolio(me, NET, VOCAB, fits, 4, 0.5);
  const all = picks.flatMap((p) => p.uniqueCoverage);
  assert.equal(all.length, new Set(all).size, "a topic must be credited to one pick only");
});

/* ── degenerate inputs ───────────────────────────────────────── */

test("empty network does not throw", () => {
  const me = profile([T("x", 1)]);
  assert.deepEqual(ranking(me, [], [], 0.12, DEFAULT_WEIGHTS), []);
  assert.deepEqual(portfolio(me, [], [], [], 5), []);
  assert.equal(brokerage(me, [], 0.12).count, 0);
  assert.equal(concentration([]), null);
});

test("a lab with no topics does not produce NaN", () => {
  const empty = lab("e", "Empty", []);
  const me = profile([T("protein language models", 1)]);
  const f = ranking(me, [...NET, empty], [...VOCAB], 0.12, DEFAULT_WEIGHTS);
  for (const r of f) for (const v of [r.foundation, r.leverage, r.growth, r.score])
    assert.ok(Number.isFinite(v), `non-finite value in fit for ${r.labId}`);
});

/* ── canonicalisation: the false-merge boundary ──────────────── */

test("morphological variants snap, near-neighbours in the same field do not", () => {
  const snap: [string, string][] = [
    ["viral evolution", "virus evolution"],
    ["genome assembly", "genomic assembly"],
    ["protein structure prediction", "protein structural prediction"],
  ];
  for (const [a, b] of snap) {
    const v = [a];
    assert.equal(canonicalise(b, v), a, `${b} should snap to ${a}`);
    assert.equal(v.length, 1);
  }
  const keep: [string, string][] = [
    ["protein language models", "protein structure prediction"],
    ["viral evolution", "viral entry"],
    ["single cell rnaseq", "single molecule imaging"],
    ["amyloid beta", "amyloid fibril kinetics"],
  ];
  for (const [a, b] of keep) {
    const v = [a];
    assert.equal(canonicalise(b, v), b, `${b} must NOT be merged into ${a}`);
    assert.equal(v.length, 2);
  }
});


/* ── direction: growth is blind to intent, this is the correction ── */

test("direction is null when nothing was stated, so it can be dropped not faked", () => {
  assert.equal(direction(NET[0], []), null);
  const sc = scarcity(NET, VOCAB), lm = labMetrics(NET, 0.12);
  const f = fitFor(profile([T("protein language models", 1)]), NET[0], sc, lm.get("a"), DEFAULT_WEIGHTS);
  assert.equal(f.direction, null);
  assert.ok(Number.isFinite(f.score), "weight must be redistributed, not left as NaN");
});

test("a lab pointing where you said you want to go scores higher than one that does not", () => {
  const asp = [T("compartmental modelling", 1), T("glymphatic clearance", 0.9)];
  // Not 1.0: amyloid beta is part of that lab and was not asked for, so it
  // correctly dilutes. Diluting is the point — direction is a share, not a flag.
  assert.ok(direction(NET[3], asp)! > 0.6, `clearance lab should be on target, got ${direction(NET[3], asp)}`);
  assert.ok(direction(NET[0], asp)! < 0.05, "PLM lab is not");
});

test("high growth with low direction is flagged, not rewarded", () => {
  // Broad record in PLM; says they want to move into clearance work.
  const me = profile(
    [T("protein language models", 1), T("viral evolution", .9)],
    [T("glymphatic clearance", 1), T("compartmental modelling", .9)],
  );
  const sc = scarcity(NET, VOCAB), lm = labMetrics(NET, 0.12);
  // PLM-C: plenty they do not have, none of it what they asked for.
  const f = fitFor(me, NET[2], sc, lm.get("c"), DEFAULT_WEIGHTS);
  assert.ok(f.growth > 0.5, `expected high growth, got ${f.growth}`);
  assert.ok(f.direction! < 0.2, `expected low direction, got ${f.direction}`);
  assert.ok(f.risks.includes("off-direction"));
});

test("stating a direction reorders the ranking", () => {
  const topics = [T("protein language models", .9), T("viral evolution", .7), T("compartmental modelling", .5)];
  const silent = ranking(profile(topics), NET, VOCAB, 0.12, DEFAULT_WEIGHTS);
  const stated = ranking(
    profile(topics, [T("glymphatic clearance", 1), T("amyloid beta", .9)]),
    NET, VOCAB, 0.12, DEFAULT_WEIGHTS,
  );
  const rank = (fits: typeof silent, id: string) => fits.findIndex((f) => f.labId === id);
  assert.ok(rank(stated, "d") < rank(silent, "d"),
    "the clearance lab must climb once clearance is the stated goal");
});

/* ── transfer: what carries across in a change of field ── */

test("transfer needs both a portable technique and somewhere new to put it", () => {
  const modeller = profile([
    T("compartmental modelling", 1, { category: "theory" }),
    T("protein language models", .8, { category: "method" }),
  ]);
  const toClearance = transfer(modeller, NET[3]);
  assert.ok(toClearance.portable.some((p) => p.label === "compartmental modelling") === false,
    "the clearance lab already has compartmental modelling, so it is not portable there");

  const plmOnly = profile([T("protein language models", 1, { category: "method" })]);
  const t = transfer(plmOnly, NET[3]);
  assert.ok(t.portable.some((p) => p.label === "protein language models"));
  assert.ok(t.targets.some((x) => x.label === "glymphatic clearance"));
  assert.ok(t.score > 0.5, `expected a real bridge, got ${t.score}`);
});

test("methods with nowhere new to apply them is not a transfer", () => {
  const plm = profile([T("protein language models", 1, { category: "method" })]);
  // A lab holding only methods offers no new system to carry them into.
  const methodsOnly = lab("m", "Methods-only", [T("variant effect prediction", 1, { category: "method" })]);
  assert.equal(transfer(plm, methodsOnly).score, 0);
});

test("no overlap and no bridge is flagged as starting over", () => {
  const alien = profile([T("stellar spectroscopy", 1, { category: "system" })]);
  const sc = scarcity(NET, VOCAB), lm = labMetrics(NET, 0.12);
  const f = fitFor(alien, NET[0], sc, lm.get("a"), DEFAULT_WEIGHTS);
  assert.ok(f.risks.includes("no-bridge"));
});

test("unmet aspiration names what the shortlist cannot give you", () => {
  const me = profile([T("protein language models", 1)], [T("cryo em", 1), T("glymphatic clearance", .8)]);
  const unmet = unmetAspiration(me, NET).map((t) => t.label);
  assert.ok(unmet.includes("cryo em"), "no lab here does cryo em");
  assert.ok(!unmet.includes("glymphatic clearance"), "the clearance lab covers this one");
});

/* ── grain: the failure that produced a graph with no edges ────
   Observed in use: three protein-design labs, nineteen labels, zero shared
   topics, no edges at any threshold. The labels were project titles, not
   subject headings. These tests pin the two halves of the fix.               */

test("labels at subject-heading grain produce edges where project titles produce none", () => {
  // What the model actually returned before the grain rule existed.
  const before: [string, string[]][] = [
    ["Huang", ["tim barrel scaffold", "deep learning protein design", "protein sequence design", "protein structure generative models"]],
    ["Chatterjee", ["discrete generative algorithms", "peptide property prediction", "crispr genome editing"]],
    ["Bitbol", ["protein language models", "sequence-function mapping", "protein interaction prediction"]],
  ];
  const vocabBefore: string[] = [];
  const labsBefore = before.map(([n, ls], i) =>
    lab(String(i), n, ls.map((l) => T(canonicalise(l, vocabBefore), 0.8))));
  const edgesBefore = edges(labsBefore).filter((e) => e.sim > 0);
  assert.equal(edgesBefore.length, 0, "reproduces the reported failure");

  // The same labs at the grain the rule now demands.
  const after: [string, string[]][] = [
    ["Huang", ["protein design", "deep learning", "protein structure prediction", "generative models"]],
    ["Chatterjee", ["generative models", "peptide design", "genome editing", "protein design"]],
    ["Bitbol", ["protein language models", "sequence function relationships", "protein interactions", "protein design"]],
  ];
  const vocabAfter: string[] = [];
  const labsAfter = after.map(([n, ls], i) =>
    lab(String(i), n, ls.map((l) => T(canonicalise(l, vocabAfter), 0.8))));
  assert.equal(edges(labsAfter).filter((e) => e.sim >= 0.12).length, 3,
    "all three pairs should now connect");
});

test("containment merges grains of one concept without merging different ones", () => {
  const merge: [string, string][] = [
    ["protein design", "protein sequence design"],
    ["protein design", "deep learning protein design"],
    ["genome editing", "crispr genome editing"],
    ["microbial evolution", "microbial evolution modeling"],
  ];
  for (const [general, specific] of merge) {
    const v = [general];
    assert.equal(canonicalise(specific, v), general, `${specific} should fold into ${general}`);
    assert.equal(v.length, 1);
  }
  const keep: [string, string][] = [
    ["cell biology", "single cell genomics"],
    ["protein design", "protein structure prediction"],
    ["antibody escape", "antibody engineering"],
    ["viral evolution", "microbial evolution"],
  ];
  for (const [a, b] of keep) {
    const v = [a];
    assert.equal(canonicalise(b, v), b, `${b} must not fold into ${a}`);
    assert.equal(v.length, 2);
  }
});

test("the seed vocabulary is internally consistent", async () => {
  const { SEED_VOCAB } = await import("./seed.js");
  assert.equal(SEED_VOCAB.length, new Set(SEED_VOCAB).size, "no duplicate seeds");
  for (const s of SEED_VOCAB) {
    assert.equal(s, s.toLowerCase().trim(), `"${s}" must be lowercase and trimmed`);
    assert.ok(s.split(/\s+/).length <= 4, `"${s}" is longer than four words`);
  }
  // Seeds must not collapse into each other, or the starting vocabulary is
  // smaller than it looks and whole areas become unreachable.
  const v: string[] = [];
  for (const s of SEED_VOCAB) canonicalise(s, v);
  const lost = SEED_VOCAB.length - v.length;
  assert.ok(lost === 0, `${lost} seed labels collapse into another seed`);
});

/* ── pursuit: credibility and appetite are different things ──── */

test("a topic moved on from still counts, but pulls less", () => {
  const topics = (p: number) => [
    T("protein language models", 1, { pursuit: p }),
    T("compartmental modelling", .9, { pursuit: 1 }),
  ];
  const sc = scarcity(NET, VOCAB), lm = labMetrics(NET, 0.12);
  const keen = fitFor(profile(topics(1)), NET[0], sc, lm.get("a"), DEFAULT_WEIGHTS);
  const done = fitFor(profile(topics(0)), NET[0], sc, lm.get("a"), DEFAULT_WEIGHTS);
  assert.ok(done.foundation < keen.foundation, "retired work must pull less");
  assert.ok(done.foundation > 0, "but must not vanish — the work happened");
  assert.ok(done.foundation / keen.foundation > 0.25, "the floor keeps real credibility on the board");
});

test("pursuit is relative, because cosine has no notion of magnitude", () => {
  // Marking everything retired changes nothing: with no other direction to
  // rotate toward, the profile still points where it always pointed. Same for
  // a single-topic profile. This is correct, and worth pinning because it is
  // the first thing that looks like a bug.
  const one = (p: number) => profile([T("protein language models", 1, { pursuit: p })]);
  const all = (p: number) => profile([
    T("protein language models", 1, { pursuit: p }), T("viral evolution", .8, { pursuit: p })]);
  const sc = scarcity(NET, VOCAB), lm = labMetrics(NET, 0.12);
  const f = (m: Profile) => fitFor(m, NET[0], sc, lm.get("a"), DEFAULT_WEIGHTS).foundation;
  assert.equal(f(one(0)), f(one(1)));
  assert.equal(f(all(0)), f(all(1)));
});

test("pursuit is ignored by leverage and transfer, which stay portable", () => {
  const done = profile([
    T("compartmental modelling", 1, { category: "theory", pursuit: 0 }),
    T("protein language models", .8, { category: "method", pursuit: 0 }),
  ]);
  const keen = profile([
    T("compartmental modelling", 1, { category: "theory", pursuit: 1 }),
    T("protein language models", .8, { category: "method", pursuit: 1 }),
  ]);
  assert.equal(transfer(done, NET[2]).score, transfer(keen, NET[2]).score,
    "a technique is portable whether or not you want to keep using it");
  const sc = scarcity(NET, VOCAB), lm = labMetrics(NET, 0.12);
  assert.equal(
    fitFor(done, NET[2], sc, lm.get("c"), DEFAULT_WEIGHTS).leverageRaw,
    fitFor(keen, NET[2], sc, lm.get("c"), DEFAULT_WEIGHTS).leverageRaw,
  );
});

test("an old side project stops steering the ranking", () => {
  // Published on influenza years ago, now wants clearance work.
  const me = profile(
    [T("influenza", 1, { pursuit: 0 }), T("compartmental modelling", .8, { pursuit: 1 }),
     T("glymphatic clearance", .5, { pursuit: 1 })],
    [T("glymphatic clearance", 1)],
  );
  const fits = ranking(me, NET, VOCAB, 0.12, DEFAULT_WEIGHTS);
  assert.equal(fits[0].labId, "d", "the clearance lab should lead, not the influenza lab");
  const flu = fits.find((f) => f.labId === "c")!;
  assert.ok(flu.retiredOverlap.some((r) => r.label === "influenza"),
    "and the influenza overlap should be named as retired");
  assert.ok(flu.risks.includes("past-self"));
});

test("profiles without pursuit behave exactly as before", () => {
  const noField = profile([T("protein language models", 1), T("viral evolution", .8)]);
  const allPursued = profile([T("protein language models", 1, { pursuit: 1 }), T("viral evolution", .8, { pursuit: 1 })]);
  const sc = scarcity(NET, VOCAB), lm = labMetrics(NET, 0.12);
  assert.equal(
    fitFor(noField, NET[0], sc, lm.get("a"), DEFAULT_WEIGHTS).foundation,
    fitFor(allPursued, NET[0], sc, lm.get("a"), DEFAULT_WEIGHTS).foundation,
  );
});
