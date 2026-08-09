import { tokens } from "../core/canonical.js";
import { LIFE_SCIENCES } from "../core/seed.js";
import type { Config } from "./provider.js";

/**
 * The rule that decides whether the graph has edges at all.
 *
 * An earlier version asked only for "specific" labels and got back project
 * titles: three labs produced nineteen labels with zero overlap, so no pair
 * could share a topic and nothing connected. Both extremes break it — generic
 * labels connect everything, specific ones connect nothing.
 */
export const GRAIN_RULE = `LABEL GRAIN — this decides whether these profiles can be compared at all.
A label is a SUBJECT HEADING that other labs in the same field would also use. It is not a project title.
  right: "protein design", "protein language models", "genome editing", "glymphatic clearance"
  wrong: "tim barrel scaffold", "light-powered molecular motors", "ensemble-conditioned sequence design"
If a label could only ever describe this one lab, it is too specific — go one level broader and put the specificity in "detail".
Prefer a label from the list above even when it is broader than the work. Coin a new label only when nothing in the list fits, and then keep it at the same grain as the list.
Never emit two labels for the same underlying topic. "protein sequence design" and "deep learning protein design" are one topic: "protein design".

detail: the lab's own specific phrasing, at most 8 words. This is shown to the reader and never compared, so put the precision here.`;

/** Labels already in use, then the field vocabulary, deduplicated. Used ones rank first. */
export const withSeed = (vocab: string[], seed: string[] = LIFE_SCIENCES): string[] => {
  const seen = new Set(vocab.map((v) => v.toLowerCase()));
  return [...vocab, ...seed.filter((s) => !seen.has(s.toLowerCase()))];
};

export const fieldVocabSchema = {
  type: "object",
  properties: { vocabulary: { type: "array", items: { type: "string" } } },
  required: ["vocabulary"],
};

/**
 * Build the topic vocabulary for whatever field the person actually works in.
 *
 * The tool shipped with a computational-biology list baked in, which made it
 * useless to an experimental chemist and quietly wrong for a wet-lab
 * biologist. Generating from their own words is the only version that
 * generalises.
 */
export function fieldVocabPrompt(description: string, keywords: string[]): string {
  return `Produce a controlled vocabulary of research subject headings for one field, to be used for comparing research groups.

THE FIELD, in the researcher's own words:
${description}

KEYWORDS THEY GAVE:
${keywords.join(", ") || "(none)"}

${GRAIN_RULE}

Return 70 to 100 labels covering this field and the areas immediately adjacent to it, so that two different groups working in it would both find labels that fit.
- Cover methods, systems, theoretical frameworks and applications. Not only the fashionable computational parts — include experimental techniques, model organisms, instruments and clinical or industrial applications where they belong to this field.
- Each label 1 to 4 words, lowercase, no punctuation.
- No two labels for the same concept, and no label that is a more specific version of another in the list.
- Order does not matter.
- Output only the labels. No commentary.`;
}


export const SYSTEM =
  "You extract structured data. You reply with JSON only. No prose, no markdown fences, no explanation.";

/**
 * `evidence` is roughly 40% of the generated tokens in a lab profile and is
 * never used in any calculation — only shown in tooltips. Turning it off is a
 * direct ~40% cut in the slowest part of the pipeline.
 */
export const labSchema = (withEvidence: boolean) => ({
  type: "object",
  properties: {
    summary: { type: "string" },
    topics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          category: { type: "string", enum: ["system", "method", "theory", "application"] },
          weight: { type: "number" },
          detail: { type: "string" },
          recency: { type: "string", enum: ["emerging", "core", "legacy"] },
          ...(withEvidence ? { evidence: { type: "string" } } : {}),
        },
        required: ["label", "category", "weight"],
      },
    },
  },
  required: ["summary", "topics"],
});

export const profileSchema = (withEvidence: boolean) => ({
  type: "object",
  properties: {
    name: { type: "string" },
    stage: { type: "string" },
    headline: { type: "string" },
    topics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          category: { type: "string", enum: ["system", "method", "theory", "application"] },
          weight: { type: "number" },
          pursuit: { type: "number" },
          detail: { type: "string" },
          ...(withEvidence ? { evidence: { type: "string" } } : {}),
        },
        required: ["label", "category", "weight"],
      },
    },
    aspiration: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          category: { type: "string", enum: ["system", "method", "theory", "application"] },
          weight: { type: "number" },
        },
        required: ["label", "category", "weight"],
      },
    },
    assets: {
      type: "array",
      items: {
        type: "object",
        properties: { kind: { type: "string" }, text: { type: "string" } },
        required: ["kind", "text"],
      },
    },
  },
  required: ["headline", "topics"],
});

/** Cheap standalone re-parse when only the intent statement changed. */
export const aspirationSchema = {
  type: "object",
  properties: {
    aspiration: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          category: { type: "string", enum: ["system", "method", "theory", "application"] },
          weight: { type: "number" },
        },
        required: ["label", "category", "weight"],
      },
    },
  },
  required: ["aspiration"],
};

/**
 * Show the model only the vocabulary that plausibly relates to this input.
 * Dumping 150 labels into a 7B model's context is how you get invented
 * synonyms, and prefill cost scales with it.
 */
export function shortlistVocab(vocab: string[], text: string, n: number): string[] {
  if (vocab.length <= n) return vocab;
  const hay = tokens(text);
  const scored = vocab.map((v) => {
    let hits = 0;
    for (const t of tokens(v)) if (hay.has(t)) hits++;
    return { v, hits };
  });
  scored.sort((a, b) => b.hits - a.hits);
  const hit = scored.filter((s) => s.hits > 0).slice(0, n).map((s) => s.v);
  return hit.length ? hit : vocab.slice(0, n);
}

export function excerpt(files: { name: string; text: string }[], cfg: Config): string {
  const out: string[] = [];
  let budget = cfg.charsTotal;
  for (const f of files) {
    if (budget <= 0) break;
    const body = (f.text ?? "").slice(0, Math.min(cfg.charsPerFile, budget));
    budget -= body.length;
    out.push(`--- ${f.name} ---\n${body}`);
  }
  return out.join("\n\n");
}

export function labPrompt(
  name: string, inst: string, desc: string, pubs: string, vocab: string[], withEvidence: boolean,
): string {
  return `Extract a structured research profile for a principal investigator so it can be compared against other labs.

REUSE THESE EXISTING TOPIC LABELS whenever the concept matches. Copy them exactly. Do not write a near-synonym:
${vocab.length ? vocab.map((v) => `"${v}"`).join(", ") : "(none yet)"}

PI: ${name}
INSTITUTION: ${inst || "unspecified"}

RESEARCH FOCUS AND RECENT PROJECTS:
${desc || "(none provided)"}

PUBLICATION TEXT:
${pubs || "(none provided)"}

${GRAIN_RULE}

Produce 5 to 8 topics, ordered by how central each is to this lab.
- label: 1 to 4 words, lowercase. Follow the grain rule above.
- weight: 1.0 defines the lab, 0.3 peripheral.
- category: system = organism, disease or setting. method = technique. theory = framework. application = translational goal.
- recency: emerging if it appears mainly in the newest work, legacy if mainly in older work, core otherwise. Use dates in the text. If you cannot tell, say core.
- summary: at most 35 words, concrete, not promotional.${
    withEvidence ? "\n- evidence: at most 10 words from the input supporting this topic." : ""
  }`;
}

export function profilePrompt(cv: string, notes: string, vocab: string[], withEvidence: boolean, keywords: string[] = []): string {
  return `Extract a structured research profile for a researcher applying to labs, so it can be compared against those labs.

REUSE THESE EXISTING TOPIC LABELS used by the labs whenever the concept matches. Copy them exactly. Do not write a near-synonym:
${vocab.length ? vocab.map((v) => `"${v}"`).join(", ") : "(none yet)"}

CV:
${cv}

WHAT THEY SAY THEY WANT TO WORK ON — keywords:
${keywords.join(", ") || "(none given)"}

ADDITIONAL NOTES FROM THE PERSON:
${notes || "(none)"}

${GRAIN_RULE}

Produce 6 to 10 topics, ordered by demonstrated depth.
- weight is DEMONSTRATED depth, not interest. 1.0 = repeated first-author output or years of hands-on work. 0.5 = one project or paper. 0.2 = touched once, or stated interest only.
- Be strict. Inflating weights makes the whole comparison useless.
- headline: at most 25 words on what kind of scientist this is.
- stage: masters, phd student, phd finishing, postdoc, or other.
- assets: up to 6 concrete checkable items (publications, methods, software, awards).${
    withEvidence ? "\n- evidence: at most 10 words from the CV supporting this topic." : ""
  }`;
}

/**
 * A publication record answers what someone has done. It does not answer what
 * they want to do next, and for a broad record those two are far apart. Keeping
 * them as separate vectors is the whole point.
 */
export function worksPrompt(
  name: string, institution: string, works: string, intent: string, vocab: string[],
  withEvidence: boolean, keywords: string[] = [],
): string {
  return `Extract a structured research profile for a researcher applying to labs, from their publication record.

REUSE THESE EXISTING TOPIC LABELS used by the labs whenever the concept matches. Copy them exactly. Do not write a near-synonym:
${vocab.length ? vocab.map((v) => `"${v}"`).join(", ") : "(none yet)"}

RESEARCHER: ${name}${institution ? ` (${institution})` : ""}

PUBLICATIONS, newest first. "[last author]" marks papers they led:
${works}

WHAT THEY SAY THEY WANT TO DO NEXT:
${intent || "(they did not say)"}

KEYWORDS FOR THE WORK THEY WANT:
${keywords.join(", ") || "(none given)"}

Return two separate topic lists. They are different things and must not be merged.

"topics" — what the record DEMONSTRATES. 6 to 10, ordered by depth.
- weight is demonstrated depth: 1.0 = repeated first or last authorship over years. 0.5 = one or two papers. 0.2 = a single contributing-author appearance.
- Recent work and led papers count for more than old contributing-author ones.
- Be strict. Inflating weights makes the whole comparison useless.

"pursuit" on each demonstrated topic — 1.0 means this is where they are heading and they want more of it, 0.0 means the work happened and they have moved on.
Judge it from what they said they want next and from the keywords, not from how good the work was. A well-cited project from four years ago that has nothing to do with their stated direction gets a low pursuit, and that is correct: it still shows they are capable, it just should not steer them back toward labs doing it.
If they gave no direction and no keywords, set every pursuit to 1.0.

"aspiration" — what they say they want NEXT, drawn from the statement above. 0 to 8 topics.
- Leave this empty if they said nothing. Do not invent intent from the publication list.
- weight is strength of intent, not familiarity. Include topics they have never published on if that is what they said they want.

${GRAIN_RULE}

Both lists: label is 1 to 4 words, lowercase, following the grain rule.
- headline: at most 25 words on what kind of scientist this is, and where they say they are heading if they said.
- stage: masters, phd student, phd finishing, postdoc, or other.
- assets: up to 6 concrete checkable items.${
    withEvidence ? "\n- evidence on demonstrated topics only: at most 10 words, naming a paper." : ""
  }`;
}

export function aspirationPrompt(intent: string, vocab: string[], keywords: string[] = []): string {
  return `Extract the research directions this person says they want to move into.

KEYWORDS THEY GAVE: ${keywords.join(", ") || "(none)"}

REUSE THESE EXISTING TOPIC LABELS whenever the concept matches. Copy them exactly:
${vocab.length ? vocab.map((v) => `"${v}"`).join(", ") : "(none yet)"}

WHAT THEY WROTE:
${intent}

${GRAIN_RULE}

Return 1 to 8 topics.
- weight is strength of intent, not current skill. Something stated as the main goal is 1.0; something mentioned in passing is 0.3.
- Extract only what they actually said. Do not add adjacent fields they did not mention.`;
}

export interface BriefInput {
  me: { headline: string; stage: string; topics: { label: string; weight: number }[]; assets: { text: string }[] };
  lab: { name: string; institution: string; summary: string; topics: { label: string; weight: number }[] };
  fit: { foundation: number; leverage: number; growth: number; direction: number | null; risks: string[] };
  transfer: { portable: string[]; targets: string[]; score: number };
  intent?: string;
  structure: { focus: number; centrality: number; momentum: number | null; clusterSize: number };
  shared: string[]; brings: string[]; learns: string[];
  portfolioRole?: string;
}

export function briefPrompt(i: BriefInput): string {
  const pct = (n: number) => n.toFixed(2);
  return `Write an honest application brief for a researcher considering this lab. No flattery, no filler, no sales language. If the fit is weak, say so plainly — an honest no saves months.

THE RESEARCHER (${i.me.stage}): ${i.me.headline}
${i.intent ? `They say they want to move toward: ${i.intent}` : ""}
Demonstrated strengths: ${i.me.topics.slice(0, 8).map((t) => `${t.label} ${pct(t.weight)}`).join(", ")}
Concrete assets: ${i.me.assets.map((a) => a.text).join("; ") || "none listed"}

THE LAB: ${i.lab.name}, ${i.lab.institution}
${i.lab.summary}
Topics: ${i.lab.topics.map((t) => `${t.label} ${pct(t.weight)}`).join(", ")}

COMPUTED, 0 to 1:
Foundation ${pct(i.fit.foundation)} (shared ground) · Leverage ${pct(i.fit.leverage)} (scarce capability the lab lacks) · Growth ${pct(i.fit.growth)} (what they have and the researcher does not)
Direction ${i.fit.direction === null ? "not stated" : pct(i.fit.direction) + " (share of this lab lying where they said they want to go)"}
Transfer ${pct(i.transfer.score)} — techniques they could carry across: ${i.transfer.portable.join(", ") || "none"}; new systems to apply them to: ${i.transfer.targets.join(", ") || "none"}
Lab focus ${pct(i.structure.focus)} (1 = single-topic specialist, 0 = broad)
Lab centrality ${pct(i.structure.centrality)} (1 = mainstream within this shortlist, 0 = isolated)
Trajectory ${i.structure.momentum === null ? "unknown" : i.structure.momentum > 0.15 ? "moving into new areas" : i.structure.momentum < -0.15 ? "weight sits in older work" : "stable"}
Flags: ${i.fit.risks.join(", ") || "none"}
${i.portfolioRole ? `Role in the shortlist: ${i.portfolioRole}` : ""}

Shared: ${i.shared.join(", ") || "none"}
Researcher brings, lab lacks: ${i.brings.join(", ") || "none"}
Lab has, researcher lacks: ${i.learns.join(", ") || "none"}

Write these sections, each starting with the bracketed label on its own line:

[Verdict] One sentence: apply, apply only if X, or do not apply. Then one sentence of reasoning grounded in the numbers above.
[Credibility] Why they would read the application seriously. If Foundation is low, say what specifically has to carry the letter instead.
[What you add] The single most defensible reason to hire this person over someone already inside the field. Name the scarce capability.
[What you'd learn] The concrete capability gained here. If Growth is low, say plainly that this is a lateral move. If Direction is low while Growth is high, say plainly that they would learn a great deal that is not what they asked for.
[Carrying it across] Only if Foundation is under 0.35 and this is a change of field. Name the specific technique from their record that transfers, and the specific system here it would be applied to. Be concrete: "your compartmental modelling on their amyloid clearance data", not "your quantitative skills". If Transfer is under 0.15, say instead that there is no obvious bridge and this would mean starting over.
[A project] One sentence naming a project only this pairing could do. Then one sentence on what would falsify it or make it fail.
[Ask them] Two specific questions for the interview that would reveal whether this lab is actually right — not questions answerable from the website.
[Watch for] The main risk. If the lab is highly focused, note the narrowing. If it is isolated in this shortlist, note the network cost. If the trajectory is backwards-looking, say so.

Under 340 words total. Plain prose under each label. Skip [Carrying it across] entirely when it does not apply.`;
}
