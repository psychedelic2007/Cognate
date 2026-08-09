import {
  DEFAULT_WEIGHTS, assetAnalysis, brokerage, canonicalise, concentration, coverage,
  edges, labMetrics, portfolio, pruneVocab, ranking, similarity, unmetAspiration,
  type Candidate, type Fit, type Lab, type LabMetrics, type Profile, type SaveFile,
  type State, type Topic, type Weights,
} from "../core/index.js";
import {
  analyseAspiration, analyseCv, analyseLab, analyseWorks, buildFieldVocab, discoverLabs,
  fetchPublications, findAuthors, getConfig, getPacks, readFileText, setConfig, writeBrief,
  type Publication, type ServerConfig, type StarterPack,
} from "./api.js";
import { Graph, YOU, chColor, type LinkDatum, type NodeDatum } from "./graph.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const KEY = "landscape:v3";
let state: State = { labs: [], vocab: [], me: null, field: null };
let cfg: ServerConfig | null = null;
let pending: { name: string; text: string }[] = [];
let cvFile: { name: string; text: string } | null = null;
let expanded = new Set<string>();
let selected: string | null = null;
let threshold = 0.12, spread = 1.0, lambda = 0.65, portfolioK = 5;
let weights: Weights = { ...DEFAULT_WEIGHTS };
let inflight: { name: string } | null = null;
let graph: Graph;
let authorMatches: Candidate[] = [];
let chosenAuthor: Candidate | null = null;
let fetchedWorks: Publication[] = [];
let discovered: Candidate[] = [];
let packs: StarterPack[] = [];
const seed = () => state.field?.vocabulary ?? [];

const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* quota */ } };
const load = () => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<State>;
      state = { labs: p.labs ?? [], vocab: p.vocab ?? [], me: p.me ?? null, field: p.field ?? null };
      if (state.me) {
        state.me.aspiration ??= [];
        state.me.aspirationNote ??= "";
      }
    }
  } catch { /* first run */ }
};

/* ── derived ─────────────────────────────────────────────────── */
const rank = (): Fit[] => (state.me ? ranking(state.me, state.labs, state.vocab, threshold, weights) : []);
const metrics = (): Map<string, LabMetrics> => labMetrics(state.labs, threshold);

/* ── adding ──────────────────────────────────────────────────── */
function absorb(topics: Topic[]): Topic[] {
  const out = topics.map((t) => ({ ...t, label: canonicalise(t.label, state.vocab) }));
  const m = new Map<string, Topic>();
  for (const t of out) {
    const prev = m.get(t.label);
    if (!prev || t.weight > prev.weight) m.set(t.label, t);
  }
  return [...m.values()];
}

async function addLab() {
  const name = ($("f-name") as HTMLInputElement).value.trim();
  const institution = ($("f-inst") as HTMLInputElement).value.trim();
  const description = ($("f-desc") as HTMLTextAreaElement).value.trim();
  if (!name) return status("Give the lab a PI name first.", "err");
  if (!description && !pending.length) return status("Add a research description or at least one file.", "err");
  if (state.labs.some((l) => l.name.toLowerCase() === name.toLowerCase()))
    return status(`${name} is already on the map. Delete them first to re-analyse.`, "err");

  ($("btn-analyse") as HTMLButtonElement).disabled = true;
  // Optimistic node: the graph shows the lab arriving instead of freezing.
  inflight = { name };
  render();
  status("Reading the material…", "run");
  const t0 = performance.now();
  try {
    const r = await analyseLab({ name, institution, description, files: pending, vocab: state.vocab, seed: seed() });
    const topics = absorb(r.topics);
    state.labs.push({
      id: "lab_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name, institution, summary: r.summary, topics,
      sources: pending.map((f) => ({ name: f.name, chars: f.text.length })),
      addedAt: new Date().toISOString(),
    });
    save();
    resetForm();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    status(`${name} added — ${topics.length} topics in ${secs}s${r._meta?.cached ? " (cached)" : ""}.`, "ok");
    tab("labs");
  } catch (e) {
    status(e instanceof Error ? e.message : String(e), "err");
  } finally {
    inflight = null;
    ($("btn-analyse") as HTMLButtonElement).disabled = false;
    render();
  }
}

function removeLab(id: string) {
  state.labs = state.labs.filter((l) => l.id !== id);
  state.vocab = pruneVocab(state.vocab, state.me ? [...state.labs, state.me] : state.labs);
  expanded.delete(id);
  if (selected === id) closeDetail();
  save();
  render();
}

async function readCv() {
  if (!cvFile) return cvStatus("Upload a CV file first.", "err");
  if (!state.labs.length)
    return cvStatus("Add at least one lab first — your profile is scored relative to the network.", "err");
  ($("btn-cv") as HTMLButtonElement).disabled = true;
  cvStatus("Reading your CV against the lab vocabulary…", "run");
  try {
    const r = await analyseCv({ cv: cvFile.text, notes: ($("cv-notes") as HTMLTextAreaElement).value.trim(), vocab: state.vocab, seed: seed(),
      keywords: state.field?.keywords ?? [] });
    state.me = {
      name: r.name || "You", stage: r.stage, headline: r.headline,
      topics: absorb(r.topics), assets: r.assets ?? [], source: cvFile.name,
      aspiration: absorb(r.aspiration ?? []), aspirationNote: "",
    };
    save(); cvStatus("", ""); render(); tab("fit");
  } catch (e) {
    cvStatus(e instanceof Error ? e.message : String(e), "err");
  } finally {
    ($("btn-cv") as HTMLButtonElement).disabled = false;
  }
}

/* ── portable save file ──────────────────────────────────────── */

/**
 * Everything lives in localStorage already, so this is not about surviving a
 * page close — it is about surviving a cleared browser, a second machine, and
 * sharing a map with someone. Re-typing twenty PIs is not a thing to ask.
 */
function saveToFile() {
  const payload: SaveFile = {
    format: "landscape", version: 1, savedAt: new Date().toISOString(), state,
    settings: { threshold, spread, lambda, portfolioK, weights: { ...weights } },
  };
  const stamp = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = `landscape-${stamp}.json`; a.click();
  URL.revokeObjectURL(url);
}

async function loadFromFile(list: FileList | null) {
  const f = Array.from(list ?? [])[0];
  if (!f) return;
  try {
    const raw = JSON.parse(await f.text()) as Partial<SaveFile> & Partial<State>;
    // Accept both a save file and a bare exported state, so neither shape is a dead end.
    const st = (raw.format === "landscape" ? raw.state : raw) as Partial<State> | undefined;
    if (!st || !Array.isArray(st.labs)) throw new Error("That file does not contain a saved map.");
    if (state.labs.length && !confirm(`Replace the current map (${state.labs.length} labs) with ${st.labs.length} from this file?`)) return;

    state = { labs: st.labs, vocab: st.vocab ?? [], me: st.me ?? null, field: st.field ?? null };
    // Rebuild the vocabulary from what is actually in the file rather than
    // trusting it: a hand-edited file can easily disagree with its own labs.
    const live = new Set(state.labs.flatMap((l) => l.topics.map((t) => t.label)));
    for (const t of state.me?.topics ?? []) live.add(t.label);
    for (const t of state.me?.aspiration ?? []) live.add(t.label);
    state.vocab = [...new Set([...state.vocab.filter((v) => live.has(v)), ...live])];
    if (state.me) { state.me.aspiration ??= []; state.me.aspirationNote ??= ""; }

    const st2 = raw.format === "landscape" ? raw.settings : undefined;
    if (st2) {
      threshold = st2.threshold ?? threshold;
      spread = st2.spread ?? spread;
      lambda = st2.lambda ?? lambda;
      portfolioK = st2.portfolioK ?? portfolioK;
      if (st2.weights) weights = { ...weights, ...(st2.weights as unknown as Weights) };
      ($("s-thr") as HTMLInputElement).value = String(threshold);
      $("v-thr").textContent = threshold.toFixed(2);
    }
    expanded.clear(); selected = null; closeDetail();
    save();
    setupDone();
    render();
    status(`Loaded ${state.labs.length} labs${state.me ? " and your profile" : ""}.`, "ok");
    tab("labs");
  } catch (e) {
    status(e instanceof Error ? e.message : String(e), "err");
  }
}

/* ── first run: what field is this person in ─────────────────── */

const setupNeeded = () => !state.field;
function setupDone() { $("setup").hidden = !setupNeeded(); }

async function renderPacks() {
  try { packs = (await getPacks()).packs; } catch { packs = []; }
  $("pack-list").innerHTML = packs.map((p) => `<button class="pack" data-id="${p.id}">
    <b>${esc(p.name)}</b><span>${esc(p.blurb)}</span><em>${p.size} topics</em></button>`).join("");
  $("pack-list").querySelectorAll<HTMLElement>(".pack").forEach((el) => (el.onclick = () => {
    const p = packs.find((x) => x.id === el.dataset.id!)!;
    applyField({ description: p.name, keywords: [], vocabulary: p.vocabulary, pack: p.id });
  }));
}

function applyField(f: Omit<import("../core/index.js").FieldConfig, "createdAt">) {
  state.field = { ...f, createdAt: new Date().toISOString() };
  save(); setupDone(); render();
}

async function generateField() {
  const description = ($("setup-desc") as HTMLTextAreaElement).value.trim();
  const keywords = ($("setup-kw") as HTMLInputElement).value.split(",").map((k) => k.trim()).filter(Boolean);
  if (!description && !keywords.length) return setupStatus("Describe your field, or give a few keywords.", "err");
  const btn = $("btn-setup") as HTMLButtonElement;
  btn.disabled = true;
  setupStatus("Building a topic vocabulary for your field… this takes one model call.", "run");
  try {
    const r = await buildFieldVocab({ description, keywords });
    applyField({ description, keywords, vocabulary: r.vocabulary });
    setupStatus("");
  } catch (e) { setupStatus(e instanceof Error ? e.message : String(e), "err"); }
  finally { btn.disabled = false; }
}

/* ── publication record instead of a CV ──────────────────────── */

async function lookupAuthor() {
  const q = ($("oa-query") as HTMLInputElement).value.trim();
  if (!q) return oaStatus("Enter your name, or an ORCID.", "err");
  oaStatus("Searching OpenAlex…", "run");
  chosenAuthor = null; fetchedWorks = [];
  try {
    const r = await findAuthors(q);
    authorMatches = r.authors;
    oaStatus(authorMatches.length === 1 ? "" : `${authorMatches.length} matches — pick yourself.`, "");
    if (authorMatches.length === 1) void pickAuthor(authorMatches[0]);
    else renderAuthorMatches();
  } catch (e) { authorMatches = []; oaStatus(e instanceof Error ? e.message : String(e), "err"); renderAuthorMatches(); }
}

async function pickAuthor(c: Candidate) {
  chosenAuthor = c;
  renderAuthorMatches();
  oaStatus(`Fetching publications for ${c.name}…`, "run");
  try {
    const r = await fetchPublications(c.authorId, 40);
    fetchedWorks = r.works;
    const led = fetchedWorks.filter((w) => w.lastAuthor).length;
    oaStatus(`${fetchedWorks.length} publications (${led} as last author). Now say where you want to go.`, "ok");
  } catch (e) { oaStatus(e instanceof Error ? e.message : String(e), "err"); }
  renderAuthorMatches();
}

function renderAuthorMatches() {
  const box = $("oa-matches");
  if (chosenAuthor) {
    box.innerHTML = `<div class="pi-card sel"><h4>${esc(chosenAuthor.name)}</h4>
      <div class="inst">${esc(chosenAuthor.institution || "—")}</div>
      <div class="meta">${chosenAuthor.worksCount} works · ${chosenAuthor.citedByCount} citations${chosenAuthor.orcid ? " · ORCID " + esc(chosenAuthor.orcid) : ""}</div>
      ${fetchedWorks.length ? `<div class="meta">${fetchedWorks.length} fetched, newest ${fetchedWorks[0]?.year ?? "?"}</div>` : ""}
      <div class="row"><button id="oa-reset">Not me — search again</button></div></div>`;
    const b = $("oa-reset"); if (b) b.onclick = () => { chosenAuthor = null; fetchedWorks = []; renderAuthorMatches(); oaStatus(""); };
    return;
  }
  box.innerHTML = authorMatches.map((c, i) => `<div class="pi-card" data-i="${i}">
    <h4>${esc(c.name)}</h4><div class="inst">${esc(c.institution || "—")}</div>
    <div class="meta">${c.worksCount} works · ${c.citedByCount} citations${c.orcid ? " · ORCID" : ""}</div>
    ${c.topicHits.length ? `<div class="chips">${c.topicHits.slice(0, 4).map((t) => `<span class="chip" style="color:var(--ink-faint)">${esc(t)}</span>`).join("")}</div>` : ""}
  </div>`).join("");
  box.querySelectorAll<HTMLElement>(".pi-card").forEach((el) =>
    (el.onclick = () => void pickAuthor(authorMatches[Number(el.dataset.i)])));
}

async function buildFromWorks() {
  if (!chosenAuthor || !fetchedWorks.length) return oaStatus("Find your publication record first.", "err");
  if (!state.labs.length) return oaStatus("Add at least one lab first — your profile is scored relative to the network.", "err");
  const intent = ($("oa-intent") as HTMLTextAreaElement).value.trim();
  ($("btn-oa") as HTMLButtonElement).disabled = true;
  oaStatus("Reading your publication record against the lab vocabulary…", "run");
  try {
    const r = await analyseWorks({
      name: chosenAuthor.name, institution: chosenAuthor.institution, intent,
      works: fetchedWorks, vocab: state.vocab, seed: seed(),
      keywords: state.field?.keywords ?? [],
    });
    state.me = {
      name: r.name || chosenAuthor.name, stage: r.stage, headline: r.headline,
      topics: absorb(r.topics), assets: r.assets ?? [],
      source: `OpenAlex · ${fetchedWorks.length} works`,
      aspiration: absorb(r.aspiration ?? []), aspirationNote: intent,
    };
    save(); oaStatus(""); render(); tab("fit");
  } catch (e) { oaStatus(e instanceof Error ? e.message : String(e), "err"); }
  finally { ($("btn-oa") as HTMLButtonElement).disabled = false; }
}

/** Re-parse only the intent statement. Cheap, so it can be iterated on. */
async function updateAspiration() {
  if (!state.me) return;
  const intent = ($("asp-note") as HTMLTextAreaElement).value.trim();
  const btn = $("btn-asp") as HTMLButtonElement;
  btn.disabled = true; btn.textContent = "Reading…";
  try {
    if (!intent) { state.me.aspiration = []; state.me.aspirationNote = ""; }
    else {
      const r = await analyseAspiration({ intent, vocab: state.vocab, seed: seed(), keywords: state.field?.keywords ?? [] });
      state.me.aspiration = absorb(r.aspiration);
      state.me.aspirationNote = intent;
    }
    save(); render();
  } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  finally { btn.disabled = false; btn.textContent = "Update direction"; }
}

/* ── discovery ───────────────────────────────────────────────── */

async function runDiscovery() {
  const btn = $("btn-discover") as HTMLButtonElement;
  if (state.labs.length < 5)
    return discStatus(`Add at least 5 labs first — with ${state.labs.length} the search has too little to go on and returns noise.`, "err");
  // Search on what the map is actually about, weighted toward stated direction.
  const weightOf = new Map<string, number>();
  for (const l of state.labs) for (const t of l.topics)
    weightOf.set(t.label, (weightOf.get(t.label) ?? 0) + t.weight);
  for (const t of state.me?.aspiration ?? []) weightOf.set(t.label, (weightOf.get(t.label) ?? 0) + t.weight * 2.5);
  const topics = [...weightOf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([l]) => l);

  btn.disabled = true;
  discStatus(`Searching OpenAlex for: ${topics.join(", ")}…`, "run");
  try {
    const r = await discoverLabs({ topics, exclude: state.labs.map((l) => l.name) });
    discovered = r.candidates;
    discStatus(`${discovered.length} candidates from ${r.searched.length} topic searches.`, "ok");
  } catch (e) { discStatus(e instanceof Error ? e.message : String(e), "err"); }
  finally { btn.disabled = false; renderDiscovery(); }
}

function renderDiscovery() {
  const box = $("disc-list");
  if (!discovered.length) { box.innerHTML = ""; return; }
  box.innerHTML = discovered.map((c, i) => `<div class="pi-card" data-i="${i}">
    <h4>${esc(c.name)}</h4><div class="inst">${esc(c.institution || "—")}</div>
    <div class="meta">matches ${c.topicHits.length} of your topics · ${c.worksCount} recent papers · ${c.citedByCount} citations</div>
    <div class="chips">${c.topicHits.slice(0, 4).map((t) => `<span class="chip" style="color:var(--ch-system)">${esc(t)}</span>`).join("")}</div>
    ${c.recentTitles.length ? `<div class="titles">${c.recentTitles.slice(0, 2).map((t) => esc(t)).join("<br>")}</div>` : ""}
    <div class="row"><button data-act="add">Fetch and add to map</button></div></div>`).join("");
  box.querySelectorAll<HTMLElement>(".pi-card").forEach((el) => {
    const c = discovered[Number(el.dataset.i)];
    el.onclick = (ev) => {
      if ((ev.target as HTMLElement).dataset.act !== "add") return;
      void addDiscovered(c);
    };
  });
}

async function addDiscovered(c: Candidate) {
  if (state.labs.some((l) => l.name.toLowerCase() === c.name.toLowerCase()))
    return discStatus(`${c.name} is already on the map.`, "err");
  discStatus(`Fetching ${c.name}'s publications…`, "run");
  inflight = { name: c.name }; render();
  try {
    const w = await fetchPublications(c.authorId, 25);
    const led = w.works.filter((x) => x.lastAuthor);
    const use = (led.length >= 5 ? led : w.works).slice(0, 20);
    const text = use.map((x) => `${x.year ?? "?"} — ${x.title}${x.abstract ? "\n" + x.abstract.slice(0, 500) : ""}`).join("\n\n");
    const r = await analyseLab({
      name: c.name, institution: c.institution,
      description: `Publication record from OpenAlex. ${led.length} of ${w.works.length} papers as last author.`,
      files: [{ name: "openalex-works.txt", text }], vocab: state.vocab, seed: seed(),
    });
    const topics = absorb(r.topics);
    state.labs.push({
      id: "lab_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: c.name, institution: c.institution, summary: r.summary, topics,
      sources: [{ name: `OpenAlex · ${use.length} works`, chars: text.length }],
      addedAt: new Date().toISOString(),
    });
    discovered = discovered.filter((x) => x.authorId !== c.authorId);
    save();
    discStatus(`${c.name} added — ${topics.length} topics.`, "ok");
  } catch (e) { discStatus(e instanceof Error ? e.message : String(e), "err"); }
  finally { inflight = null; renderDiscovery(); render(); }
}

/* ── graph data ──────────────────────────────────────────────── */
function graphData(): { nodes: NodeDatum[]; links: LinkDatum[] } {
  const nodes: NodeDatum[] = [];
  const links: LinkDatum[] = [];
  const fits = state.me ? new Map(rank().map((f) => [f.labId, f])) : null;

  for (const l of state.labs)
    nodes.push({ id: l.id, kind: "lab", lab: l, fit: fits?.get(l.id) ?? null, r: 20 + Math.min(12, l.topics.length * 1.6) });
  if (inflight) nodes.push({ id: "__pending", kind: "pending", r: 22, label: inflight.name });

  for (const e of edges(state.labs))
    if (e.sim >= threshold) links.push({ source: e.a, target: e.b, kind: "peer", sim: e.sim, shared: e.shared });

  if (state.me) {
    nodes.push({ id: "me", kind: "me", r: 26 });
    for (const l of state.labs) {
      const f = fits!.get(l.id)!;
      if (f.foundation >= threshold) links.push({ source: "me", target: l.id, kind: "me", sim: f.foundation, fit: f });
    }
  }
  for (const id of expanded) {
    const l = state.labs.find((x) => x.id === id);
    if (!l) continue;
    l.topics.forEach((t, i) => {
      nodes.push({ id: `${id}::${i}`, kind: "topic", topic: t, parent: id, r: 5 + t.weight * 7 });
      links.push({ source: id, target: `${id}::${i}`, kind: "child", sim: t.weight });
    });
  }
  return { nodes, links };
}

/* ── render ──────────────────────────────────────────────────── */
function render() {
  $("c-lab").textContent = String(state.labs.length);
  $("c-topic").textContent = String(new Set(state.labs.flatMap((l) => l.topics.map((t) => t.label))).size);
  $("c-link").textContent = String(edges(state.labs).filter((e) => e.sim >= threshold).length);
  $("c-you").textContent = state.me ? "CV loaded" : "no CV";
  $("hint").style.display = state.labs.length || inflight ? "none" : "flex";
  const fl = $("field-line");
  if (fl) fl.textContent = state.field
    ? `${state.field.description} · ${state.field.vocabulary.length} canonical topics${state.field.keywords.length ? ` · ${state.field.keywords.join(", ")}` : ""}`
    : "Not set.";

  renderLabs(); renderYou(); renderFit();
  const { nodes, links } = graphData();
  graph.render(nodes, links, {
    width: $("canvas").clientWidth, height: $("canvas").clientHeight,
    spread, selected, expanded, me: state.me,
  });
}

function renderLabs() {
  const box = $("lablist");
  if (!state.labs.length) {
    box.innerHTML = '<div class="empty">No labs yet. Add one from the first tab — a research description alone is enough to start.</div>';
    return;
  }
  const lm = metrics();
  box.innerHTML = state.labs.map((l) => {
    const m = lm.get(l.id)!;
    return `<div class="pi-card ${selected === l.id ? "sel" : ""}" data-id="${l.id}">
      <h4>${esc(l.name)}</h4><div class="inst">${esc(l.institution || "—")}</div>
      <div class="chips">${l.topics.slice(0, 4).map((t) => `<span class="chip" style="color:${chColor(t.category)}">${esc(t.label)}</span>`).join("")}
        ${l.topics.length > 4 ? `<span class="chip" style="color:var(--ink-faint)">+${l.topics.length - 4}</span>` : ""}</div>
      <div class="meta">cluster ${m.cluster} · focus ${m.focus.toFixed(2)} · centrality ${m.centrality.toFixed(2)}${m.momentum !== null ? ` · trajectory ${m.momentum > 0 ? "+" : ""}${m.momentum.toFixed(2)}` : ""}</div>
      <div class="row"><button data-act="focus">${expanded.has(l.id) ? "Hide topics" : "Show topics"}</button>
        <button data-act="del" class="del">Delete</button></div></div>`;
  }).join("");

  box.querySelectorAll<HTMLElement>(".pi-card").forEach((card) => {
    const id = card.dataset.id!;
    card.addEventListener("click", (ev) => {
      const act = (ev.target as HTMLElement).dataset.act;
      if (act === "del") { ev.stopPropagation(); removeLab(id); return; }
      if (act === "focus") { ev.stopPropagation(); expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); return; }
      openDetail(state.labs.find((l) => l.id === id)!);
    });
  });
}

function renderYou() {
  const empty = $("you-empty"), filled = $("you-filled");
  if (!state.me) { empty.hidden = false; filled.hidden = true; return; }
  empty.hidden = true; filled.hidden = false;
  const a = assetAnalysis(state.me, state.labs, state.vocab);
  const cov = coverage(state.me, state.labs, state.vocab);

  filled.innerHTML = `
    <div class="diag"><h5>${esc(state.me.name)}</h5><p>${esc(state.me.headline)}</p>
      <p class="mono">${esc(state.me.stage)} · from ${esc(state.me.source)}</p></div>

    <div class="diag ${cov < 0.5 ? "alert" : "good"}"><h5>Shortlist covers ${(cov * 100).toFixed(0)}% of your profile</h5>
      <p>${cov < 0.5
        ? "More than half of what you have built is unused by every lab on this map. Either this shortlist serves only part of you, or the rest of your profile is not what you should be applying with. Both are worth knowing before you write anything."
        : "Most of your demonstrated work is engaged by at least one lab here. The shortlist matches the researcher you actually are."}</p></div>

    <h4 class="rail-h" style="margin-top:20px">Scarce here — lead with these</h4>
    <p class="note">Few of these ${a.n} labs have them, so they are the reason to hire you over a candidate already inside the field.</p>
    ${a.scarce.length
      ? a.scarce.map((r) => `<div class="asset"><span class="a-n" style="color:${chColor(r.category)}">${esc(r.label)}</span>
        <span class="a-d">${r.df}/${a.n} labs</span><span class="a-s" style="color:${YOU}">${r.value.toFixed(2)}</span></div>`).join("")
      : '<div class="empty">Nothing scarce. Every skill you have is widely held across these labs — you would be competing on volume rather than distinctiveness.</div>'}

    ${a.common.length ? `<h4 class="rail-h" style="margin-top:22px">Will not differentiate you</h4>
      <p class="note">Table stakes here. They get you past a first filter and distinguish you from nobody. Do not build a letter around them.</p>
      ${a.common.map((r) => `<div class="asset"><span class="a-n" style="color:var(--ink-mute)">${esc(r.label)}</span><span class="a-d">${r.df}/${a.n} labs</span></div>`).join("")}` : ""}

    ${a.absent.length ? `<h4 class="rail-h" style="margin-top:22px">Nobody here does this</h4>
      <p class="note">Either you are mapping the wrong labs for this part of your profile, or it is not a differentiator in this field.</p>
      <div class="chips">${a.absent.map((r) => `<span class="chip" style="color:var(--warn)">${esc(r.label)}</span>`).join("")}</div>` : ""}

    <div class="hr"></div>
    <h4 class="rail-h">Where you want to go next</h4>
    <p class="note">Kept separate from what you have done. Without it, Growth counts everything a lab could teach you — including things you have no interest in.</p>
    <textarea id="asp-note" placeholder="e.g. I want to move from viral sequence modelling into protein biophysics, keeping the dynamical-systems side.">${esc(state.me.aspirationNote)}</textarea>
    <div style="height:8px"></div>
    <button class="btn ghost sm" id="btn-asp">Update direction</button>
    ${state.me.aspiration.length ? `<div class="chips" style="margin-top:10px">${state.me.aspiration.map((t) => `<span class="chip" style="color:var(--ch-theory)">${esc(t.label)} ${t.weight.toFixed(1)}</span>`).join("")}</div>` : ""}

    <div class="hr"></div>
    <h4 class="rail-h">Demonstrated topics — still pursuing?</h4>
    <p class="note">A project you have moved on from still makes you credible, so it is never erased. But it stops pulling the ranking toward labs doing it. Switch anything off that you do not want to keep doing.</p>
    <p class="note">Check these before trusting anything downstream. If every weight sits above 0.7 the extraction inflated, and every number after it is wrong.</p>
    ${[...state.me.topics].sort((x, y) => y.weight - x.weight).map((t, i) => {
      const pursued = (t.pursuit ?? 1) >= 0.5;
      return `<div class="pursue ${pursued ? "" : "off"}">
        ${tbar(t)}
        <button class="pbtn" data-label="${esc(t.label)}" title="${pursued ? "Counts fully toward shared ground" : "Counted at 30% — the work is real, the pull is gone"}">
          ${pursued ? "pursuing" : "moved on"}</button></div>`;
    }).join("")}

    ${state.me.assets.length ? `<h4 class="rail-h" style="margin-top:20px">Concrete assets</h4>
      ${state.me.assets.map((x) => `<div class="asset"><span class="a-n">${esc(x.text)}</span><span class="a-d">${esc(x.kind)}</span></div>`).join("")}` : ""}

    <div class="hr"></div><button class="btn ghost" id="btn-cv-clear">Remove my CV</button>`;

  const ab = $("btn-asp"); if (ab) ab.onclick = () => void updateAspiration();
  filled.querySelectorAll<HTMLElement>(".pbtn").forEach((b) => (b.onclick = () => {
    const t = state.me!.topics.find((x) => x.label === b.dataset.label);
    if (!t) return;
    t.pursuit = (t.pursuit ?? 1) >= 0.5 ? 0 : 1;
    save(); render();
  }));
  $("btn-cv-clear").onclick = () => {
    state.me = null; cvFile = null; $("cv-list").innerHTML = "";
    state.vocab = pruneVocab(state.vocab, state.labs);
    save(); render();
  };
}

const tbar = (t: Topic, extra = "") =>
  `<div class="tbar"><div class="tb-top"><span>${esc(t.label)}</span><em>${t.weight.toFixed(2)}${extra}</em></div>
   <div class="track"><div class="fill" style="width:${t.weight * 100}%;background:${chColor(t.category)}"></div></div>
   ${t.detail ? `<div class="det">${esc(t.detail)}</div>` : ""}
   ${t.evidence ? `<div class="ev">${esc(t.evidence)}</div>` : ""}</div>`;

const axisRow = (label: string, val: number, color: string) =>
  `<div class="axis"><span class="a-l">${label}</span>
   <span class="a-t"><span class="a-f" style="width:${Math.min(100, val * 100)}%;background:${color}"></span></span>
   <span class="a-v">${val.toFixed(2)}</span></div>`;

const RISK_TEXT: Record<string, string> = {
  "thin-foundation": "Shared ground below the credibility floor",
  redundant: "You duplicate what they already have",
  "nothing-to-learn": "Little here you cannot already do",
  isolated: "Disconnected from the rest of your shortlist",
  declining: "Their weight sits in older work",
  "off-direction": "Lots to learn, but not what you asked for",
  "no-bridge": "No shared ground and no method that carries across",
  "past-self": "You overlap on work you have moved on from",
};

function renderFit() {
  const box = $("fit-body");
  if (!state.me) {
    box.innerHTML = '<div class="empty">Upload your CV on the You tab and every lab gets scored on three axes.<br><br>One number would hide which axis is carrying it, and that is the only thing worth knowing.</div>';
    return;
  }
  if (!state.labs.length) { box.innerHTML = '<div class="empty">Add labs to rank.</div>'; return; }

  const fits = rank();
  const lm = metrics();
  const byId = new Map(state.labs.map((l) => [l.id, l]));
  const conc = concentration(fits.slice(0, 5).map((f) => byId.get(f.labId)!));
  const brok = brokerage(state.me, state.labs, threshold);
  const picks = portfolio(state.me, state.labs, state.vocab, fits, portfolioK, lambda);
  const clusterCount = new Set([...lm.values()].map((m) => m.cluster)).size;

  box.innerHTML = `
    <h4 class="rail-h">Where to apply</h4>
    <p class="note">A ranked list is the wrong deliverable — its top five are usually near-duplicates, which is five shots at one target. This picks the best <em>set</em>, trading a little individual fit for independence between applications.</p>
    <div class="ctrl"><span>Applications <b>${portfolioK}</b></span>
      <input type="range" class="you" id="p-k" min="2" max="8" step="1" value="${portfolioK}"></div>
    <div class="ctrl"><span>Fit vs independence <b>${lambda.toFixed(2)}</b></span>
      <input type="range" class="you" id="p-l" min="0.1" max="1" step="0.05" value="${lambda}">
      <div class="note">1.00 is the plain ranking. Lower buys diversification.</div></div>

    ${picks.length ? picks.map((p, i) => {
      const l = byId.get(p.labId)!, m = lm.get(p.labId)!;
      return `<div class="rank pick" data-id="${p.labId}">
        <div class="r-top"><span class="r-pos">${i + 1}</span><span class="r-name">${esc(l.name)}</span>
          <span class="r-score">${p.fit.score.toFixed(0)}</span></div>
        <div class="r-inst">${esc(l.institution || "—")} · cluster ${m.cluster}</div>
        <div class="why">${p.uniqueCoverage.length
          ? `Only pick using <b>${p.uniqueCoverage.slice(0, 3).map(esc).join(", ")}</b>`
          : "Adds no new part of your profile — it is here on fit alone"}</div>
      </div>`;
    }).join("") : '<div class="empty">No lab clears the credibility floor. Your profile does not overlap any of these enough to be read seriously. Map labs closer to your actual work.</div>'}

    <div class="hr"></div><h4 class="rail-h">Diagnostics</h4>
    ${conc ? `<div class="diag ${conc.mean > 0.35 ? "alert" : "good"}">
      <h5>${conc.mean > 0.35 ? "Top-ranked labs are concentrated" : "Top-ranked labs are diversified"}</h5>
      <p>Mean similarity among your top ${conc.labs.length} is <span class="mono">${conc.mean.toFixed(2)}</span>.
      ${conc.mean > 0.35
        ? "These labs largely do the same thing. One funding shift takes out every application at once, and if you are rejected for fit you will be rejected for the same reason everywhere."
        : "They draw on different parts of your profile, so a rejection from one carries little information about the others."}</p></div>` : ""}

    <div class="diag ${brok.count ? "good" : ""}">
      <h5>${brok.count ? `You bridge ${brok.count} disconnected pair${brok.count > 1 ? "s" : ""}` : "You bridge nothing yet"}</h5>
      <p>${brok.count
        ? `These labs do not connect to each other, but you connect to both — a specific claim for a cover letter: ${brok.bridges.slice(0, 3).map((b) => `<span class="mono">${esc(b.a)} ⟷ ${esc(b.b)}</span>`).join(", ")}.`
        : "Every lab you reach is already connected to the others. You sit inside one cluster, so distinctiveness has to come from depth rather than breadth."}</p></div>

    ${(() => {
      if (!state.me!.aspiration.length) return "";
      const unmet = unmetAspiration(state.me!, state.labs);
      if (!unmet.length) return `<div class="diag good"><h5>Your shortlist covers everything you asked for</h5>
        <p>Every direction you named is worked on by at least one lab here.</p></div>`;
      return `<div class="diag alert"><h5>${unmet.length} stated direction${unmet.length > 1 ? "s" : ""} no lab here offers</h5>
        <p>You said you want <span class="mono">${unmet.slice(0, 4).map((t) => esc(t.label)).join(", ")}</span>, and no lab on this map works on it.
        Either the shortlist is wrong for where you are heading, or that direction is not realistic from here. Try the discovery search.</p></div>`;
    })()}
    <div class="diag"><h5>${clusterCount} cluster${clusterCount > 1 ? "s" : ""} on this map</h5>
      <p>${clusterCount === 1
        ? "Every lab here is linked to every other. This shortlist is one field. If that is deliberate, fine — if not, you are seeing one option presented five ways."
        : `Your map splits into ${clusterCount} separate groups. Applications spread across clusters fail independently.`}</p></div>

    <div class="hr"></div>
    <div class="ctrl"><span>Foundation <b>${weights.foundation.toFixed(2)}</b></span>
      <input type="range" class="you" id="w-f" min="0" max="1" step="0.05" value="${weights.foundation}"></div>
    <div class="ctrl"><span>Leverage <b>${weights.leverage.toFixed(2)}</b></span>
      <input type="range" class="you" id="w-l" min="0" max="1" step="0.05" value="${weights.leverage}"></div>
    <div class="ctrl"><span>Growth <b>${weights.growth.toFixed(2)}</b></span>
      <input type="range" class="you" id="w-g" min="0" max="1" step="0.05" value="${weights.growth}"></div>
    ${state.me.aspiration.length ? `<div class="ctrl"><span>Direction <b>${weights.direction.toFixed(2)}</b></span>
      <input type="range" class="you" id="w-d" min="0" max="1" step="0.05" value="${weights.direction}"></div>`
      : '<p class="note">Direction is unavailable — say where you want to go on the You tab and it becomes a fourth axis. Without it, Growth counts everything a lab could teach you, including things you have no interest in.</p>'}
    <p class="note">Set Leverage and Growth to zero for a pure similarity ranking — the naive answer — and see how far it differs.</p>

    <div class="hr"></div><h4 class="rail-h">Every lab, ranked</h4>
    ${fits.map((f, i) => {
      const l = byId.get(f.labId)!;
      return `<div class="rank" data-id="${f.labId}">
        <div class="r-top"><span class="r-pos">${String(i + 1).padStart(2, "0")}</span>
          <span class="r-name">${esc(l.name)}</span><span class="r-score">${f.score.toFixed(0)}</span></div>
        <div class="r-inst">${esc(l.institution || "—")}</div>
        <div class="axes">${axisRow("Foundation", f.foundation, YOU)}${axisRow("Leverage", f.leverage, "#4C8DFF")}${axisRow("Growth", f.growth, "#3ED598")}${f.direction !== null ? axisRow("Direction", f.direction, "#C77DFF") : ""}</div>
        ${f.risks.length ? `<div class="flags">${f.risks.map((r) => `<span class="flag">${esc(RISK_TEXT[r] ?? r)}</span>`).join("")}</div>` : ""}
      </div>`;
    }).join("")}
    <p class="note" style="margin-top:14px">Bars are absolute values, not percentiles. Low foundation with high leverage means a striking hire who must prove they can speak the language. High foundation with low leverage means the third person doing the same thing.</p>`;

  box.querySelectorAll<HTMLElement>(".rank").forEach((c) =>
    (c.onclick = () => openDetail(byId.get(c.dataset.id!)!)));
  const bind = (id: string, set: (v: number) => void) => {
    const el = $(id) as HTMLInputElement;
    if (el) el.oninput = (e) => { set(Number((e.target as HTMLInputElement).value)); renderFit(); render(); };
  };
  bind("w-f", (v) => (weights.foundation = v));
  bind("w-l", (v) => (weights.leverage = v));
  bind("w-g", (v) => (weights.growth = v));
  bind("p-k", (v) => (portfolioK = v));
  bind("p-l", (v) => (lambda = v));
  bind("w-d", (v) => (weights.direction = v));
}

/* ── detail drawer ───────────────────────────────────────────── */
function openDetail(lab: Lab) {
  selected = lab.id;
  $("detail").classList.add("open");
  $("d-name").textContent = lab.name;
  $("d-inst").textContent = lab.institution || "—";
  const fits = rank();
  const fit = fits.find((f) => f.labId === lab.id) ?? null;
  const m = metrics().get(lab.id)!;
  const picks = state.me ? portfolio(state.me, state.labs, state.vocab, fits, portfolioK, lambda) : [];
  const pick = picks.find((p) => p.labId === lab.id);

  const structure = `<div class="strip">
    <span title="1 = one topic dominates, 0 = spread evenly">focus <b>${m.focus.toFixed(2)}</b></span>
    <span title="1 = linked to every other lab here, 0 = isolated">centrality <b>${m.centrality.toFixed(2)}</b></span>
    <span>cluster <b>${m.cluster}</b></span>
    ${m.momentum !== null ? `<span title="positive = moving into new areas">trajectory <b>${m.momentum > 0 ? "+" : ""}${m.momentum.toFixed(2)}</b></span>` : ""}
  </div>`;

  const fitHTML = !fit ? "" : `<div class="fitbox">
    <div class="fb-top"><b>Your fit</b><em>${fit.score.toFixed(0)}</em></div>
    ${axisRow("Foundation", fit.foundation, YOU)}${axisRow("Leverage", fit.leverage, YOU)}${axisRow("Growth", fit.growth, YOU)}${fit.direction !== null ? axisRow("Direction", fit.direction, "#C77DFF") : ""}
    ${fit.gate < 1 ? `<div class="note warn">Shared ground is below the credibility floor, so leverage is discounted to ${(fit.gate * 100).toFixed(0)}%. Raw leverage was ${fit.leverageRaw.toFixed(2)}.</div>` : ""}
    ${fit.risks.length ? `<div class="flags">${fit.risks.map((r) => `<span class="flag">${esc(RISK_TEXT[r] ?? r)}</span>`).join("")}</div>` : ""}
    ${fit.retiredOverlap.length ? `<div class="note warn">Shared ground here rests partly on work you have moved on from: ${fit.retiredOverlap.slice(0, 3).map((x) => esc(x.label)).join(", ")}. Counted at ${Math.round(0.3 * 100)}%.</div>` : ""}
    ${pick ? `<div class="note" style="color:${YOU}">In your shortlist at position ${picks.indexOf(pick) + 1}${pick.uniqueCoverage.length ? ` — the only pick using ${pick.uniqueCoverage.slice(0, 3).map(esc).join(", ")}` : ""}.</div>` : ""}
    <div style="margin-top:10px">
      <div class="note">You bring, they lack</div>
      <div class="chips">${fit.missing.slice(0, 5).map((x) => `<span class="chip" style="color:${YOU}">${esc(x.label)} · ${x.df}/${state.labs.length}</span>`).join("") || '<span class="note">nothing scarce</span>'}</div>
      <div class="note" style="margin-top:9px">You'd learn here</div>
      <div class="chips">${fit.learn.slice(0, 5).map((x) => `<span class="chip" style="color:var(--ch-method)">${esc(x.label)}</span>`).join("") || '<span class="note">nothing new</span>'}</div>
    </div>
    ${fit.foundation < 0.35 ? `<div class="transfer">
      <div class="tr-top"><b>Changing field</b><em>${fit.transfer.score.toFixed(2)}</em></div>
      ${fit.transfer.score < 0.15
        ? '<p class="note warn">No obvious bridge. You bring no technique this lab lacks, or they offer no new system to apply one to. This would be starting over rather than transferring.</p>'
        : `<p class="note">Carry <span class="mono">${fit.transfer.portable.slice(0, 3).map((x) => esc(x.label)).join(", ")}</span> into <span class="mono">${fit.transfer.targets.slice(0, 3).map((x) => esc(x.label)).join(", ")}</span>. That pairing is the argument — not that you are interested in their field.</p>`}
    </div>` : ""}
    <div style="height:11px"></div>
    <button class="btn ghost sm" id="btn-brief">Write the application brief</button>
    <div id="brief-out"></div></div>`;

  const conns = edges(state.labs).filter((e) => e.a === lab.id || e.b === lab.id).sort((x, y) => y.sim - x.sim)
    .map((e) => {
      const o = state.labs.find((l) => l.id === (e.a === lab.id ? e.b : e.a))!;
      return `<div class="conn"><div class="c-top"><b>${esc(o.name)}</b><em>${e.sim.toFixed(3)}</em></div>
        <div class="chips">${e.shared.slice(0, 8).map((s) => {
          const cat = lab.topics.find((t) => t.label === s.label)?.category ?? "method";
          return `<span class="chip" style="color:${chColor(cat)}">${esc(s.label)}</span>`;
        }).join("")}</div></div>`;
    }).join("");

  $("d-body").innerHTML = `${fitHTML}${structure}<p class="sum">${esc(lab.summary)}</p>
    <h4 class="d-sec">Research topics</h4>
    ${[...lab.topics].sort((a, b) => b.weight - a.weight).map((t) => {
      const mine = state.me?.topics.find((x) => x.label === t.label);
      return tbar(t, mine ? ` · you ${mine.weight.toFixed(2)}` : "");
    }).join("")}
    <h4 class="d-sec" style="margin-top:20px">Overlap with other labs</h4>
    ${conns || '<div class="empty">No overlap yet.</div>'}`;

  const btn = $("btn-brief") as HTMLButtonElement | null;
  if (btn && fit) {
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = "Writing…";
      try {
        const r = await writeBrief({
          me: { headline: state.me!.headline, stage: state.me!.stage, topics: state.me!.topics, assets: state.me!.assets },
          lab: { name: lab.name, institution: lab.institution, summary: lab.summary, topics: lab.topics },
          fit: { foundation: fit.foundation, leverage: fit.leverage, growth: fit.growth, direction: fit.direction, risks: fit.risks },
          transfer: {
            portable: fit.transfer.portable.slice(0, 4).map((x) => x.label),
            targets: fit.transfer.targets.slice(0, 4).map((x) => x.label),
            score: fit.transfer.score,
          },
          intent: state.me!.aspirationNote || undefined,
          structure: { focus: m.focus, centrality: m.centrality, momentum: m.momentum, clusterSize: state.labs.length },
          shared: fit.shared.slice(0, 6).map((s) => s.label),
          brings: fit.missing.slice(0, 5).map((x) => x.label),
          learns: fit.learn.slice(0, 5).map((x) => x.label),
          portfolioRole: pick ? `shortlist position ${picks.indexOf(pick) + 1}, uniquely covering ${pick.uniqueCoverage.slice(0, 3).join(", ") || "nothing new"}` : "not in the shortlist",
        });
        $("brief-out").innerHTML = `<div class="brief">${esc(r.text)}</div>`;
        btn.remove();
      } catch (e) {
        $("brief-out").innerHTML = `<div class="note warn">${esc(e instanceof Error ? e.message : e)}</div>`;
        btn.disabled = false; btn.textContent = "Write the application brief";
      }
    };
  }
  render();
}
function closeDetail() { $("detail").classList.remove("open"); selected = null; render(); }

/* ── files, status, tabs ─────────────────────────────────────── */
const status = (m: string, k = "") => { const s = $("status"); s.textContent = m; s.className = "status " + k; };
const cvStatus = (m: string, k = "") => { const s = $("cv-status"); s.textContent = m; s.className = "status " + k; };
const oaStatus = (m: string, k = "") => { const s = $("oa-status"); s.textContent = m; s.className = "status " + k; };
const discStatus = (m: string, k = "") => { const s = $("disc-status"); s.textContent = m; s.className = "status " + k; };
const setupStatus = (m: string, k = "") => { const s = $("setup-status"); s.textContent = m; s.className = "status " + k; };
function tab(name: string) {
  document.querySelectorAll<HTMLElement>(".rail-tabs button").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll<HTMLElement>("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
}
async function stageFiles(list: FileList | null) {
  const files = Array.from(list ?? []).filter((f) => /\.(md|markdown|txt|pdf)$/i.test(f.name));
  if (!files.length) return status("Only .md, .txt and .pdf files can be read.", "err");
  for (const f of files) {
    try { pending.push({ name: f.name, text: await readFileText(f, (m) => status(m, "run")) }); status(""); }
    catch (e) { status(e instanceof Error ? e.message : String(e), "err"); }
  }
  renderFiles();
}
function renderFiles() {
  $("filelist").innerHTML = pending.map((f, i) =>
    `<div class="filerow"><span>${esc(f.name)}</span><span>${(f.text.length / 1000).toFixed(1)}k</span>
     <button data-i="${i}" aria-label="Remove">✕</button></div>`).join("");
  $("filelist").querySelectorAll<HTMLButtonElement>("button").forEach((b) =>
    (b.onclick = () => { pending.splice(Number(b.dataset.i), 1); renderFiles(); }));
}
function resetForm() {
  (["f-name", "f-inst", "f-desc"] as const).forEach((i) => (($(i) as HTMLInputElement).value = ""));
  pending = []; renderFiles();
}
async function stageCv(list: FileList | null) {
  const f = Array.from(list ?? []).find((x) => /\.(pdf|md|markdown|txt)$/i.test(x.name));
  if (!f) return cvStatus("Upload a .pdf, .md or .txt file.", "err");
  try {
    cvFile = { name: f.name, text: await readFileText(f, (m) => cvStatus(m, "run")) };
    $("cv-list").innerHTML = `<div class="filerow"><span>${esc(cvFile.name)}</span><span>${(cvFile.text.length / 1000).toFixed(1)}k</span></div>`;
    cvStatus("");
  } catch (e) { cvStatus(e instanceof Error ? e.message : String(e), "err"); }
}

/* ── boot ────────────────────────────────────────────────────── */
async function boot() {
  load();
  graph = new Graph($<HTMLElement>("svg") as unknown as SVGSVGElement, {
    onLabClick: (lab) => { expanded.has(lab.id) ? expanded.delete(lab.id) : expanded.add(lab.id); openDetail(lab); },
    onMeClick: () => tab("you"),
    onTopicClick: (label) => graph.highlight(label, state.labs, state.me),
    onHover: (html, ev) => {
      const t = $("tip");
      if (!html || !ev) { t.style.opacity = "0"; return; }
      const b = $("canvas").getBoundingClientRect();
      t.innerHTML = html; t.style.opacity = "1";
      t.style.left = Math.min(ev.clientX - b.left + 16, b.width - t.offsetWidth - 12) + "px";
      t.style.top = Math.min(ev.clientY - b.top + 14, b.height - t.offsetHeight - 12) + "px";
    },
  });

  document.querySelectorAll<HTMLElement>(".rail-tabs button").forEach((b) => (b.onclick = () => tab(b.dataset.tab!)));
  $("btn-analyse").onclick = addLab;
  $("btn-cv").onclick = readCv;
  $("btn-oa-find").onclick = () => void lookupAuthor();
  $("btn-oa").onclick = () => void buildFromWorks();
  $("btn-discover").onclick = () => void runDiscovery();
  ($("oa-query") as HTMLInputElement).addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void lookupAuthor();
  });
  document.querySelectorAll<HTMLElement>(".src-tabs button").forEach((b) => (b.onclick = () => {
    document.querySelectorAll<HTMLElement>(".src-tabs button").forEach((x) =>
      x.setAttribute("aria-selected", String(x === b)));
    document.querySelectorAll<HTMLElement>("[data-src]").forEach((p) => (p.hidden = p.dataset.src !== b.dataset.src));
  }));
  $("d-close").onclick = closeDetail;
  $("drop").onclick = () => $("f-files").click();
  ($("f-files") as HTMLInputElement).onchange = (e) => {
    const el = e.target as HTMLInputElement; void stageFiles(el.files); el.value = "";
  };
  $("cv-drop").onclick = () => $("cv-file").click();
  ($("cv-file") as HTMLInputElement).onchange = (e) => {
    const el = e.target as HTMLInputElement; void stageCv(el.files); el.value = "";
  };
  ([["drop", stageFiles], ["cv-drop", stageCv]] as const).forEach(([id, fn]) => {
    const el = $(id);
    ["dragenter", "dragover"].forEach((t) => el.addEventListener(t, (e) => { e.preventDefault(); el.classList.add("hot"); }));
    ["dragleave", "drop"].forEach((t) => el.addEventListener(t, (e) => { e.preventDefault(); el.classList.remove("hot"); }));
    el.addEventListener("drop", (e) => void fn((e as DragEvent).dataTransfer?.files ?? null));
  });
  ($("s-thr") as HTMLInputElement).oninput = (e) => {
    threshold = Number((e.target as HTMLInputElement).value);
    $("v-thr").textContent = threshold.toFixed(2); render();
  };
  ($("s-spread") as HTMLInputElement).oninput = (e) => {
    spread = Number((e.target as HTMLInputElement).value);
    $("v-spread").textContent = spread.toFixed(1); render();
  };
  $("btn-save").onclick = saveToFile;
  $("btn-load").onclick = () => $("load-file").click();
  ($("load-file") as HTMLInputElement).onchange = (e) => {
    const el = e.target as HTMLInputElement; void loadFromFile(el.files); el.value = "";
  };
  $("btn-setup").onclick = () => void generateField();
  $("btn-refield").onclick = () => { state.field = null; save(); setupDone(); };
  $("btn-export").onclick = () => {
    const fits = rank(), lm = metrics();
    const byId = new Map(state.labs.map((l) => [l.id, l]));
    const payload = {
      exported: new Date().toISOString(), labs: state.labs, vocabulary: state.vocab, profile: state.me,
      unmetAspiration: state.me ? unmetAspiration(state.me, state.labs).map((t) => t.label) : [],
      labMetrics: [...lm.values()],
      assets: state.me ? assetAnalysis(state.me, state.labs, state.vocab) : null,
      coverage: state.me ? coverage(state.me, state.labs, state.vocab) : null,
      brokerage: state.me ? brokerage(state.me, state.labs, threshold) : null,
      concentration: concentration(fits.slice(0, 5).map((f) => byId.get(f.labId)!)),
      shortlist: state.me ? portfolio(state.me, state.labs, state.vocab, fits, portfolioK, lambda)
        .map((p, i) => ({ position: i + 1, lab: byId.get(p.labId)!.name, uniqueCoverage: p.uniqueCoverage })) : [],
      ranking: fits.map((f) => ({
        lab: byId.get(f.labId)!.name, institution: byId.get(f.labId)!.institution,
        index: +f.score.toFixed(1), foundation: +f.foundation.toFixed(3),
        leverage: +f.leverage.toFixed(3), growth: +f.growth.toFixed(3),
        direction: f.direction === null ? null : +f.direction.toFixed(3),
        transfer: { score: +f.transfer.score.toFixed(3),
          portable: f.transfer.portable.slice(0, 4).map((x) => x.label),
          targets: f.transfer.targets.slice(0, 4).map((x) => x.label) },
        risks: f.risks,
        youBringTheyLack: f.missing.slice(0, 5).map((x) => x.label),
        youdLearn: f.learn.slice(0, 5).map((x) => x.label),
      })),
      edges: edges(state.labs).map((e) => ({
        a: byId.get(e.a)!.name, b: byId.get(e.b)!.name,
        similarity: +e.sim.toFixed(4), sharedTopics: e.shared.map((s) => s.label),
      })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = "landscape.json"; a.click(); URL.revokeObjectURL(url);
  };
  $("btn-clear").onclick = () => {
    if (!state.labs.length) return;
    if (!confirm(`Remove all ${state.labs.length} labs? Your CV profile stays.`)) return;
    state.labs = []; state.vocab = pruneVocab(state.vocab, state.me ? [state.me] : []);
    expanded.clear(); selected = null; closeDetail(); save(); render();
  };
  ($("svg") as unknown as SVGSVGElement).addEventListener("click", () => { if (selected) closeDetail(); });
  window.addEventListener("resize", () => render());

  setupDone();
  void renderPacks();
  render();

  try {
    cfg = await getConfig();
    const sel = $("f-model") as HTMLSelectElement;
    sel.innerHTML = cfg.models.map((m) => `<option value="${m}" ${m === cfg!.model ? "selected" : ""}>${m}</option>`).join("")
      || '<option>no models installed</option>';
    ($("f-fast") as HTMLInputElement).checked = cfg.fast;
    $("cfg-line").textContent = `${cfg.provider} · ctx ${cfg.numCtx} · ${cfg.concurrency} parallel`;
    if (!cfg.ollamaUp) status("Ollama is not responding. Run `ollama serve`, then reload.", "err");
    sel.onchange = () => void setConfig({ model: sel.value });
    ($("f-fast") as HTMLInputElement).onchange = (e) =>
      void setConfig({ fast: (e.target as HTMLInputElement).checked });
  } catch { status("Cannot reach the server.", "err"); }
}

void boot();
