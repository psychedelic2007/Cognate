import type { Candidate, Topic } from "../core/types.js";

/* ────────────────────────────────────────────────────────────────
   PDF text extraction

   The "Setting up fake worker" warning means pdf.js could not load its
   worker and fell back to parsing on the main thread — it still works, but
   it blocks the UI for the whole document. It happens when the worker is
   cross-origin or blocked by CSP. Serving the worker from our own origin
   removes the problem entirely.
   ──────────────────────────────────────────────────────────────── */

let pdfjs: typeof import("pdfjs-dist") | null = null;

async function getPdfjs() {
  if (!pdfjs) {
    pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.min.mjs", import.meta.url).href;
  }
  return pdfjs;
}

export async function readFileText(f: File, onProgress?: (msg: string) => void): Promise<string> {
  if (!/\.pdf$/i.test(f.name)) return f.text();

  const lib = await getPdfjs();
  const doc = await lib.getDocument({ data: await f.arrayBuffer() }).promise;
  const limit = Math.min(doc.numPages, 60);
  const pages: string[] = [];
  for (let i = 1; i <= limit; i++) {
    onProgress?.(`Reading ${f.name} — page ${i} of ${limit}`);
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  const text = pages.join("\n\n").replace(/[ \t]+/g, " ").trim();
  if (text.length < 120)
    throw new Error(
      `${f.name} has almost no extractable text — it is probably a scan. Export a text-based PDF, or paste the content instead.`,
    );
  return text;
}

/* ────────────────────────────────────────────────────────────────
   Server
   ──────────────────────────────────────────────────────────────── */

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({ error: "The server returned something unreadable." }))) as
    | T
    | { error: string };
  if (!res.ok || (data as { error?: string }).error)
    throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}.`);
  return data as T;
}

export interface ServerConfig {
  provider: string; model: string; models: string[]; ollamaUp: boolean;
  fast: boolean; concurrency: number; numCtx: number; anthropicAvailable: boolean;
}

export const getConfig = (): Promise<ServerConfig> => fetch("/api/config").then((r) => r.json());
export const setConfig = (patch: Partial<{ model: string; fast: boolean; provider: string }>) =>
  post<{ ok: boolean }>("/api/config", patch);

export interface LabResult {
  summary: string; topics: Topic[];
  _meta?: { cached?: boolean; attempt?: number; model?: string; promptChars?: number };
}
export interface CvResult {
  name: string; stage: string; headline: string; topics: Topic[];
  aspiration?: Topic[];
  assets: { kind: string; text: string }[];
  _meta?: { cached?: boolean; attempt?: number; model?: string };
}

export const analyseLab = (b: {
  name: string; institution: string; description: string;
  files: { name: string; text: string }[]; vocab: string[]; seed: string[];
}) => post<LabResult>("/api/lab", b);

export const analyseCv = (b: {
  cv: string; notes: string; vocab: string[]; seed: string[]; keywords: string[];
}) => post<CvResult>("/api/cv", b);

export interface StarterPack { id: string; name: string; blurb: string; vocabulary: string[]; size: number }
export const getPacks = () => fetch("/api/packs").then((r) => r.json() as Promise<{ packs: StarterPack[] }>);
export const buildFieldVocab = (b: { description: string; keywords: string[] }) =>
  post<{ vocabulary: string[]; cached: boolean }>("/api/field", b);

export const writeBrief = (b: unknown) => post<{ text: string; cached: boolean }>("/api/brief", b);

/**
 * Batch analysis over server-sent events. Results arrive as each lab lands
 * rather than all at the end, so the graph fills in progressively.
 */
export async function analyseLabsStream(
  labs: unknown[],
  on: {
    start?: (d: { total: number; concurrency: number }) => void;
    lab?: (d: { index: number; name: string; result: LabResult }) => void;
    error?: (d: { index: number; name: string; error: string }) => void;
  },
): Promise<void> {
  const res = await fetch("/api/labs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labs }),
  });
  if (!res.body) throw new Error("The server did not stream a response.");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const ev = /^event: (.+)$/m.exec(frame)?.[1];
      const raw = /^data: (.+)$/m.exec(frame)?.[1];
      if (!ev || !raw) continue;
      const data = JSON.parse(raw);
      if (ev === "start") on.start?.(data);
      else if (ev === "lab") on.lab?.(data);
      else if (ev === "error") on.error?.(data);
    }
  }
}


/* ────────────────────────────────────────────────────────────────
   OpenAlex — publication record without a CV

   Google Scholar has no API and blocks programmatic access, so a name or an
   ORCID is resolved through OpenAlex instead. Same data, no CAPTCHA.
   ──────────────────────────────────────────────────────────────── */

export interface Publication {
  title: string; year: number | null; abstract: string; venue: string;
  topics: string[]; citedBy: number; lastAuthor: boolean;
}

export const findAuthors = (query: string) =>
  post<{ authors: Candidate[] }>("/api/authors", { query });

export const fetchPublications = (authorId: string, limit = 40) =>
  post<{ works: Publication[] }>("/api/publications", { authorId, limit });

export const analyseWorks = (b: {
  name: string; institution: string; intent: string;
  works: Publication[]; vocab: string[]; seed: string[]; keywords: string[];
}) => post<CvResult & { aspiration: Topic[] }>("/api/works", b);

export const analyseAspiration = (b: { intent: string; vocab: string[]; seed: string[]; keywords: string[] }) =>
  post<{ aspiration: Topic[] }>("/api/aspiration", b);

export const discoverLabs = (b: { topics: string[]; exclude: string[] }) =>
  post<{ candidates: Candidate[]; searched: string[] }>("/api/discover", b);
