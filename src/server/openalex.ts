/**
 * OpenAlex, not Google Scholar.
 *
 * Scholar has no API, forbids scraping, and CAPTCHAs programmatic requests
 * within a handful of calls — shipping a scraper means every user of an
 * open-source tool hits a block on day one. OpenAlex is free, keyless, covers
 * ~250M works, and returns structured topics and affiliations that would have
 * to be inferred from Scholar HTML anyway.
 *
 * ORCID is used when the person has one, since it is authoritative.
 */
import type { Candidate } from "../core/types.js";

const OA = "https://api.openalex.org";

/** OpenAlex asks for a contact address in exchange for the faster pool. */
let MAILTO = process.env.OPENALEX_MAILTO ?? "";
export const setMailto = (m: string) => { MAILTO = m; };
const polite = (u: URL) => { if (MAILTO) u.searchParams.set("mailto", MAILTO); return u.toString(); };

async function get<T>(url: URL): Promise<T> {
  const res = await fetch(polite(url), {
    headers: { Accept: "application/json", "User-Agent": `landscape/0.3 (${MAILTO || "openalex"})` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429) throw new Error("OpenAlex is rate limiting. Set OPENALEX_MAILTO to your email and retry.");
  if (!res.ok) throw new Error(`OpenAlex returned ${res.status}`);
  return (await res.json()) as T;
}

/* ── shapes we actually use ────────────────────────────────── */
interface OAAuthor {
  id: string; display_name: string; orcid?: string | null;
  works_count: number; cited_by_count: number;
  last_known_institutions?: { display_name: string }[];
  last_known_institution?: { display_name: string } | null;
  topics?: { display_name: string }[];
}
interface OAWork {
  id: string; title: string | null; publication_year: number | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  authorships?: { author: { id: string; display_name: string }; author_position: string;
    institutions?: { display_name: string }[] }[];
  topics?: { display_name: string }[];
  cited_by_count?: number;
  primary_location?: { source?: { display_name?: string } | null } | null;
}

const instOf = (a: OAAuthor) =>
  a.last_known_institutions?.[0]?.display_name ?? a.last_known_institution?.display_name ?? "";

/** OpenAlex stores abstracts as a word→positions index. Rebuild the text. */
function abstractOf(w: OAWork): string {
  const idx = w.abstract_inverted_index;
  if (!idx) return "";
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(idx)) for (const p of positions) slots[p] = word;
  return slots.filter(Boolean).join(" ").slice(0, 1400);
}

/** Accepts a bare ORCID, an ORCID URL, an OpenAlex id, or a name. */
export function parseIdentifier(input: string): { kind: "orcid" | "openalex" | "name"; value: string } {
  const s = input.trim();
  const orcid = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i.exec(s);
  if (orcid) return { kind: "orcid", value: orcid[1] };
  const oa = /\b(A\d{6,})\b/.exec(s);
  if (oa) return { kind: "openalex", value: oa[1] };
  // A Scholar URL cannot be resolved directly, but the name usually can.
  const scholar = /scholar\.google\.[a-z.]+\/citations\?.*\buser=([\w-]+)/i.exec(s);
  if (scholar) return { kind: "name", value: "" };
  return { kind: "name", value: s };
}

export async function findAuthors(input: string): Promise<Candidate[]> {
  const id = parseIdentifier(input);
  if (id.kind === "name" && !id.value)
    throw new Error(
      "A Google Scholar link cannot be looked up directly — Scholar has no API. Paste your name, or better, your ORCID.",
    );

  if (id.kind === "orcid") {
    const a = await get<OAAuthor>(new URL(`${OA}/authors/orcid:${id.value}`));
    return [toCandidate(a)];
  }
  if (id.kind === "openalex") {
    const a = await get<OAAuthor>(new URL(`${OA}/authors/${id.value}`));
    return [toCandidate(a)];
  }
  const u = new URL(`${OA}/authors`);
  u.searchParams.set("search", id.value);
  u.searchParams.set("per-page", "8");
  const r = await get<{ results: OAAuthor[] }>(u);
  if (!r.results.length) throw new Error(`No author matching "${id.value}" in OpenAlex.`);
  return r.results.map(toCandidate);
}

const toCandidate = (a: OAAuthor): Candidate => ({
  authorId: a.id.replace(/.*\//, ""),
  name: a.display_name,
  institution: instOf(a),
  worksCount: a.works_count,
  citedByCount: a.cited_by_count,
  topicHits: (a.topics ?? []).slice(0, 6).map((t) => t.display_name),
  recentTitles: [],
  orcid: a.orcid?.replace(/.*\//, "") ?? undefined,
});

export interface Publication {
  title: string; year: number | null; abstract: string; venue: string;
  topics: string[]; citedBy: number; lastAuthor: boolean;
}

export async function fetchWorks(authorId: string, limit = 40): Promise<Publication[]> {
  const u = new URL(`${OA}/works`);
  u.searchParams.set("filter", `author.id:${authorId},type:article`);
  u.searchParams.set("sort", "publication_date:desc");
  u.searchParams.set("per-page", String(Math.min(limit, 100)));
  u.searchParams.set(
    "select",
    "id,title,publication_year,abstract_inverted_index,authorships,topics,cited_by_count,primary_location",
  );
  const r = await get<{ results: OAWork[] }>(u);
  return r.results.map((w) => {
    const auths = w.authorships ?? [];
    const mine = auths.findIndex((a) => a.author.id.endsWith(authorId));
    return {
      title: w.title ?? "",
      year: w.publication_year,
      abstract: abstractOf(w),
      venue: w.primary_location?.source?.display_name ?? "",
      topics: (w.topics ?? []).slice(0, 4).map((t) => t.display_name),
      citedBy: w.cited_by_count ?? 0,
      lastAuthor: mine >= 0 && mine === auths.length - 1,
    };
  }).filter((p) => p.title);
}

/**
 * Find PIs publishing on the topics the map is already about.
 *
 * Last authorship is used as a proxy for running the lab. That convention
 * holds in most of biology and medicine and fails in mathematics, physics and
 * economics, where author order is alphabetical or contribution-based. The
 * caller is told, rather than the heuristic being hidden.
 */
export async function discover(
  topics: string[], exclude: string[] = [], perTopic = 60,
): Promise<{ candidates: Candidate[]; searched: string[] }> {
  const searched = topics.slice(0, 6);
  const tally = new Map<string, {
    name: string; inst: string; hits: Set<string>; works: number; cites: number; titles: string[];
  }>();
  const skip = new Set(exclude.map((e) => e.toLowerCase().trim()));

  for (const topic of searched) {
    const u = new URL(`${OA}/works`);
    u.searchParams.set("search", topic);
    u.searchParams.set("filter", "publication_year:>2021,type:article");
    u.searchParams.set("sort", "cited_by_count:desc");
    u.searchParams.set("per-page", String(perTopic));
    u.searchParams.set("select", "title,authorships,cited_by_count,publication_year");
    let r: { results: OAWork[] };
    try { r = await get<{ results: OAWork[] }>(u); } catch { continue; }

    for (const w of r.results) {
      const auths = w.authorships ?? [];
      if (auths.length < 2) continue;
      const last = auths[auths.length - 1];
      const key = last.author.id.replace(/.*\//, "");
      if (skip.has(last.author.display_name.toLowerCase())) continue;
      const entry = tally.get(key) ?? {
        name: last.author.display_name,
        inst: last.institutions?.[0]?.display_name ?? "",
        hits: new Set<string>(), works: 0, cites: 0, titles: [],
      };
      entry.hits.add(topic);
      entry.works += 1;
      entry.cites += w.cited_by_count ?? 0;
      if (entry.titles.length < 3 && w.title) entry.titles.push(w.title);
      if (!entry.inst && last.institutions?.[0]) entry.inst = last.institutions[0].display_name;
      tally.set(key, entry);
    }
  }

  const candidates = [...tally.entries()]
    .map(([authorId, e]): Candidate => ({
      authorId, name: e.name, institution: e.inst,
      worksCount: e.works, citedByCount: e.cites,
      topicHits: [...e.hits], recentTitles: e.titles,
    }))
    // Breadth across searched topics first: someone appearing under four of
    // your topics is far more relevant than someone with one runaway paper.
    .filter((c) => c.worksCount >= 2)
    .sort((a, b) => b.topicHits.length - a.topicHits.length
      || b.worksCount - a.worksCount || b.citedByCount - a.citedByCount)
    .slice(0, 25);

  return { candidates, searched };
}
