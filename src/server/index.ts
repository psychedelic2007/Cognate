import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cacheGet, cacheKey, cacheSet, defaults, generate, listModels, mapLimit,
  parseJson, warmup, type Config,
} from "./provider.js";
import {
  SYSTEM, aspirationPrompt, aspirationSchema, briefPrompt, excerpt, labPrompt, labSchema,
  fieldVocabPrompt, fieldVocabSchema, profilePrompt, profileSchema, shortlistVocab,
  withSeed, worksPrompt, type BriefInput,
} from "./prompts.js";
import { LIFE_SCIENCES, STARTER_PACKS } from "../core/seed.js";
import { discover, fetchWorks, findAuthors, setMailto } from "./openalex.js";
import type { Category, Recency, Topic } from "../core/types.js";

const ROOT = join(fileURLToPath(new URL("../../", import.meta.url)));
const PUBLIC = join(ROOT, "public");

const cfg: Config = { ...defaults };
let withEvidence = true;

/* ── argument parsing ──────────────────────────────────────── */
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (arg("model")) cfg.model = arg("model")!;
if (arg("ollama")) cfg.ollamaUrl = arg("ollama")!;
if (arg("ctx")) cfg.numCtx = Number(arg("ctx"));
if (arg("keep-alive")) cfg.keepAlive = arg("keep-alive")!;
if (arg("concurrency")) cfg.concurrency = Number(arg("concurrency"));
if (argv.includes("--fast")) { withEvidence = false; cfg.charsTotal = 9000; cfg.numPredict = 600; }
if (process.env.ANTHROPIC_API_KEY) {
  cfg.anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (argv.includes("--anthropic")) {
    cfg.provider = "anthropic";
    cfg.model = arg("model") ?? "claude-sonnet-4-6";
  }
}
const PORT = Number(arg("port") ?? 7800);
if (arg("mailto")) setMailto(arg("mailto")!);

/* ── normalisation ─────────────────────────────────────────── */
const CATS: Category[] = ["system", "method", "theory", "application"];
const RECS: Recency[] = ["emerging", "core", "legacy"];

function normTopics(raw: unknown, cap: number): Topic[] {
  if (!Array.isArray(raw)) return [];
  const out: Topic[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const label = String(r.label ?? "").toLowerCase().trim().replace(/\s+/g, " ");
    if (!label) continue;
    out.push({
      label,
      category: CATS.includes(r.category as Category) ? (r.category as Category) : "method",
      weight: Math.max(0.05, Math.min(1, Number(r.weight) || 0.5)),
      recency: RECS.includes(r.recency as Recency) ? (r.recency as Recency) : "core",
      detail: r.detail ? String(r.detail).slice(0, 70) : undefined,
      pursuit: r.pursuit === undefined ? undefined : Math.max(0, Math.min(1, Number(r.pursuit))),
      evidence: r.evidence ? String(r.evidence).slice(0, 90) : undefined,
    });
  }
  return out.slice(0, cap);
}

/* ── analysis ──────────────────────────────────────────────── */
interface LabReq {
  name: string; institution?: string; description?: string;
  files?: { name: string; text: string }[]; vocab?: string[]; seed?: string[];
}

async function analyseLab(body: LabReq) {
  const files = body.files ?? [];
  const pubs = excerpt(files, cfg);
  const vocab = body.vocab ?? [];
  const short = shortlistVocab(withSeed(vocab, body.seed?.length ? body.seed : LIFE_SCIENCES), (body.description ?? "") + " " + pubs, cfg.vocabShortlist);
  const prompt = labPrompt(body.name, body.institution ?? "", body.description ?? "", pubs, short, withEvidence);

  const key = cacheKey(["lab", cfg.model, withEvidence, prompt]);
  const hit = await cacheGet<Record<string, unknown>>(cfg, key);
  if (hit) return { ...hit, _meta: { cached: true, model: cfg.model } };

  let last: unknown = null;
  for (let attempt = 0; attempt < cfg.retries; attempt++) {
    try {
      const raw = await generate(cfg, SYSTEM, prompt, {
        schema: attempt < 2 ? labSchema(withEvidence) : undefined,
        json: attempt >= 2,
      });
      const data = parseJson<Record<string, unknown>>(raw);
      const topics = normTopics(data.topics, 8);
      if (topics.length < 3) throw new Error(`only ${topics.length} usable topics`);
      const out = { summary: String(data.summary ?? "").slice(0, 300), topics };
      await cacheSet(cfg, key, out);
      return { ...out, _meta: { cached: false, attempt: attempt + 1, model: cfg.model, promptChars: prompt.length } };
    } catch (e) { last = e; }
  }
  throw new Error(
    `${cfg.model} could not produce a usable profile after ${cfg.retries} attempts (${last}). ` +
    `Try a larger model, or add a fuller research description.`,
  );
}

interface CvReq { cv: string; notes?: string; vocab?: string[]; seed?: string[]; keywords?: string[]; }

async function analyseCv(body: CvReq) {
  const vocab = body.vocab ?? [];
  const cv = (body.cv ?? "").slice(0, cfg.charsTotal * 2);
  const short = shortlistVocab(withSeed(vocab, body.seed?.length ? body.seed : LIFE_SCIENCES), cv + " " + (body.keywords ?? []).join(" "), cfg.vocabShortlist);
  const prompt = profilePrompt(cv, body.notes ?? "", short, withEvidence, body.keywords ?? []);

  const key = cacheKey(["cv", cfg.model, withEvidence, prompt]);
  const hit = await cacheGet<Record<string, unknown>>(cfg, key);
  if (hit) return { ...hit, _meta: { cached: true, model: cfg.model } };

  let last: unknown = null;
  for (let attempt = 0; attempt < cfg.retries; attempt++) {
    try {
      const raw = await generate(cfg, SYSTEM, prompt, {
        schema: attempt < 2 ? profileSchema(withEvidence) : undefined,
        json: attempt >= 2,
        maxTokens: cfg.numPredict + 300,
      });
      const data = parseJson<Record<string, unknown>>(raw);
      const topics = normTopics(data.topics, 10);
      if (topics.length < 3) throw new Error(`only ${topics.length} usable topics`);
      const out = {
        aspiration: normTopics(data.aspiration, 8),
        name: String(data.name ?? "You").slice(0, 60),
        stage: String(data.stage ?? "").slice(0, 40),
        headline: String(data.headline ?? "").slice(0, 220),
        topics,
        assets: (Array.isArray(data.assets) ? data.assets : []).slice(0, 6).map((a: Record<string, unknown>) => ({
          kind: String(a.kind ?? "").slice(0, 20), text: String(a.text ?? "").slice(0, 140),
        })),
      };
      await cacheSet(cfg, key, out);
      return { ...out, _meta: { cached: false, attempt: attempt + 1, model: cfg.model } };
    } catch (e) { last = e; }
  }
  throw new Error(`Could not read the CV after ${cfg.retries} attempts (${last}). It may be a scan, or too short.`);
}

interface WorksReq {
  name: string; institution?: string; intent?: string; vocab?: string[];
  seed?: string[]; keywords?: string[];
  works: { title: string; year: number | null; abstract: string; venue: string; lastAuthor: boolean }[];
}

async function analyseWorks(body: WorksReq) {
  const vocab = body.vocab ?? [];
  // Newest first, abstracts trimmed: a local model degrades fast on long input,
  // and the recent led papers carry nearly all the signal.
  const works = (body.works ?? []).slice(0, 40).map((w) =>
    `${w.year ?? "?"}${w.lastAuthor ? " [last author]" : ""} — ${w.title}` +
    (w.venue ? ` (${w.venue})` : "") +
    (w.abstract ? `\n   ${w.abstract.slice(0, 420)}` : "")).join("\n");

  const short = shortlistVocab(withSeed(vocab, body.seed?.length ? body.seed : LIFE_SCIENCES), works + " " + (body.intent ?? "") + " " + (body.keywords ?? []).join(" "), cfg.vocabShortlist);
  const prompt = worksPrompt(body.name, body.institution ?? "", works, body.intent ?? "", short, withEvidence, body.keywords ?? []);

  const key = cacheKey(["works", cfg.model, withEvidence, prompt]);
  const hit = await cacheGet<Record<string, unknown>>(cfg, key);
  if (hit) return { ...hit, _meta: { cached: true, model: cfg.model } };

  let last: unknown = null;
  for (let attempt = 0; attempt < cfg.retries; attempt++) {
    try {
      const raw = await generate(cfg, SYSTEM, prompt, {
        schema: attempt < 2 ? profileSchema(withEvidence) : undefined,
        json: attempt >= 2, maxTokens: cfg.numPredict + 400,
      });
      const data = parseJson<Record<string, unknown>>(raw);
      const topics = normTopics(data.topics, 10);
      if (topics.length < 3) throw new Error(`only ${topics.length} usable topics`);
      const out = {
        name: body.name,
        stage: String(data.stage ?? "").slice(0, 40),
        headline: String(data.headline ?? "").slice(0, 220),
        topics,
        aspiration: normTopics(data.aspiration, 8),
        assets: (Array.isArray(data.assets) ? data.assets : []).slice(0, 6).map((a: Record<string, unknown>) => ({
          kind: String(a.kind ?? "").slice(0, 20), text: String(a.text ?? "").slice(0, 140),
        })),
      };
      await cacheSet(cfg, key, out);
      return { ...out, _meta: { cached: false, attempt: attempt + 1, model: cfg.model, works: body.works?.length ?? 0 } };
    } catch (e) { last = e; }
  }
  throw new Error(`Could not build a profile from those publications after ${cfg.retries} attempts (${last}).`);
}

async function analyseAspiration(body: { intent: string; vocab?: string[]; seed?: string[]; keywords?: string[] }) {
  const short = shortlistVocab(withSeed(body.vocab ?? [], body.seed?.length ? body.seed : LIFE_SCIENCES),
    body.intent + " " + (body.keywords ?? []).join(" "), cfg.vocabShortlist);
  const prompt = aspirationPrompt(body.intent, short, body.keywords ?? []);
  const key = cacheKey(["asp", cfg.model, prompt]);
  const hit = await cacheGet<{ aspiration: unknown }>(cfg, key);
  if (hit) return { aspiration: normTopics(hit.aspiration, 8), _meta: { cached: true } };
  const raw = await generate(cfg, SYSTEM, prompt, { schema: aspirationSchema, maxTokens: 500 });
  const data = parseJson<Record<string, unknown>>(raw);
  const aspiration = normTopics(data.aspiration, 8);
  await cacheSet(cfg, key, { aspiration });
  return { aspiration, _meta: { cached: false } };
}

/** Build a controlled vocabulary for whatever field the person actually works in. */
async function buildFieldVocab(description: string, keywords: string[]) {
  const prompt = fieldVocabPrompt(description, keywords);
  const key = cacheKey(["field", cfg.model, prompt]);
  const hit = await cacheGet<{ vocabulary: string[] }>(cfg, key);
  if (hit) return { ...hit, cached: true };

  let last: unknown = null;
  for (let attempt = 0; attempt < cfg.retries; attempt++) {
    try {
      const raw = await generate(cfg, SYSTEM, prompt, {
        schema: attempt < 2 ? fieldVocabSchema : undefined, json: attempt >= 2, maxTokens: 1600,
      });
      const data = parseJson<{ vocabulary: unknown }>(raw);
      const clean = [...new Set((Array.isArray(data.vocabulary) ? data.vocabulary : [])
        .map((v) => String(v).toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, " "))
        .filter((v) => v && v.split(" ").length <= 5))];
      if (clean.length < 25) throw new Error(`only ${clean.length} usable labels`);
      const out = { vocabulary: clean.slice(0, 120) };
      await cacheSet(cfg, key, out);
      return { ...out, cached: false };
    } catch (e) { last = e; }
  }
  throw new Error(`Could not build a vocabulary for that field (${last}). Describe it in a sentence or two, or pick a starter pack.`);
}

async function writeBrief(input: BriefInput) {
  const prompt = briefPrompt(input);
  const key = cacheKey(["brief", cfg.model, prompt]);
  const hit = await cacheGet<{ text: string }>(cfg, key);
  if (hit) return { ...hit, cached: true };
  const text = (await generate(cfg, "You write short, blunt, useful research career advice.", prompt, { maxTokens: 900 }))
    .replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const out = { text };
  await cacheSet(cfg, key, out);
  return { ...out, cached: false };
}

/* ── HTTP ──────────────────────────────────────────────────── */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
};

const send = (res: ServerResponse, code: number, body: unknown, type = "application/json") => {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(code, { "Content-Type": type, "Content-Length": data.length });
  res.end(data);
};

const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > 60 * 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    req.on("error", reject);
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  try {
    if (req.method === "GET" && path === "/api/config") {
      let models: string[] = [];
      let ollamaUp = true;
      try { models = await listModels(cfg); } catch { ollamaUp = false; }
      return send(res, 200, {
        provider: cfg.provider, model: cfg.model, models, ollamaUp,
        fast: !withEvidence, concurrency: cfg.concurrency, numCtx: cfg.numCtx,
        anthropicAvailable: Boolean(cfg.anthropicKey),
      });
    }

    if (req.method === "POST" && path === "/api/config") {
      const b = await readBody(req);
      if (typeof b.model === "string") cfg.model = b.model;
      if (typeof b.fast === "boolean") {
        withEvidence = !b.fast;
        cfg.charsTotal = b.fast ? 9000 : defaults.charsTotal;
        cfg.numPredict = b.fast ? 600 : defaults.numPredict;
      }
      if (b.provider === "anthropic" && cfg.anthropicKey) cfg.provider = "anthropic";
      if (b.provider === "ollama") cfg.provider = "ollama";
      void warmup(cfg);
      return send(res, 200, { ok: true, model: cfg.model, provider: cfg.provider, fast: !withEvidence });
    }

    if (req.method === "POST" && path === "/api/lab") {
      return send(res, 200, await analyseLab((await readBody(req)) as unknown as LabReq));
    }

    if (req.method === "POST" && path === "/api/cv") {
      return send(res, 200, await analyseCv((await readBody(req)) as unknown as CvReq));
    }

    if (req.method === "GET" && path === "/api/packs") {
      return send(res, 200, { packs: STARTER_PACKS.map((p) => ({ ...p, size: p.vocabulary.length })) });
    }

    if (req.method === "POST" && path === "/api/field") {
      const b = await readBody(req);
      const description = String(b.description ?? "").trim();
      const keywords = (Array.isArray(b.keywords) ? b.keywords : []).map(String);
      if (!description && !keywords.length)
        return send(res, 400, { error: "Describe the field, or give a few keywords." });
      return send(res, 200, await buildFieldVocab(description, keywords));
    }

    if (req.method === "POST" && path === "/api/works") {
      return send(res, 200, await analyseWorks((await readBody(req)) as unknown as WorksReq));
    }

    if (req.method === "POST" && path === "/api/aspiration") {
      const b = await readBody(req);
      return send(res, 200, await analyseAspiration({ intent: String(b.intent ?? ""), vocab: b.vocab as string[] }));
    }

    // OpenAlex — no key, no scraping, no CAPTCHA.
    if (req.method === "POST" && path === "/api/authors") {
      const b = await readBody(req);
      return send(res, 200, { authors: await findAuthors(String(b.query ?? "")) });
    }

    if (req.method === "POST" && path === "/api/publications") {
      const b = await readBody(req);
      return send(res, 200, { works: await fetchWorks(String(b.authorId ?? ""), Number(b.limit ?? 40)) });
    }

    if (req.method === "POST" && path === "/api/discover") {
      const b = await readBody(req);
      const topics = (b.topics ?? []) as string[];
      if (topics.length < 2) return send(res, 400, { error: "Need at least two topics to search on." });
      return send(res, 200, await discover(topics, (b.exclude ?? []) as string[]));
    }

    if (req.method === "POST" && path === "/api/brief") {
      return send(res, 200, await writeBrief((await readBody(req)) as unknown as BriefInput));
    }

    // Batch with server-sent progress: results stream back as each lab lands,
    // so the graph fills in instead of blocking on the slowest one.
    if (req.method === "POST" && path === "/api/labs") {
      const b = await readBody(req);
      const items = (b.labs ?? []) as LabReq[];
      res.writeHead(200, {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive",
      });
      const emit = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      emit("start", { total: items.length, concurrency: cfg.concurrency });
      await mapLimit(items, cfg.concurrency, async (item, i) => {
        try { emit("lab", { index: i, name: item.name, result: await analyseLab(item) }); }
        catch (e) { emit("error", { index: i, name: item.name, error: String(e) }); }
      });
      emit("done", {});
      return res.end();
    }

    if (req.method === "GET") {
      const rel = path === "/" ? "index.html" : normalize(path).replace(/^(\.\.[/\\])+/, "");
      const file = join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");
      try {
        const buf = await readFile(file);
        return send(res, 200, buf, MIME[extname(file)] ?? "application/octet-stream");
      } catch { return send(res, 404, "not found", "text/plain"); }
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED"))
      return send(res, 502, { error: `Cannot reach Ollama at ${cfg.ollamaUrl}. Is \`ollama serve\` running?` });
    send(res, 500, { error: msg });
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`Landscape  ·  ${cfg.provider}  ·  ${cfg.model}  ·  ctx ${cfg.numCtx}  ·  keep_alive ${cfg.keepAlive}${withEvidence ? "" : "  ·  fast mode"}`);
  console.log(`http://localhost:${PORT}\n`);
  if (cfg.provider === "ollama") {
    try {
      const models = await listModels(cfg);
      if (!models.includes(cfg.model))
        console.log(`!  ${cfg.model} is not installed. Available: ${models.join(", ") || "none"}\n`);
      console.log("Loading the model so the first request doesn't pay for it…");
      await warmup(cfg);
      console.log("Ready.\n");
    } catch {
      console.log(`!  Ollama is not responding at ${cfg.ollamaUrl}. Start it with: ollama serve\n`);
    }
  }
});
