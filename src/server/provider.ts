import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Config {
  provider: "ollama" | "anthropic";
  ollamaUrl: string;
  model: string;
  numCtx: number;
  /**
   * Ollama unloads a model after 5 minutes idle by default, so every request
   * after a pause pays a multi-GB reload. If the tool feels *inconsistently*
   * slow, this is almost always why.
   */
  keepAlive: string;
  temperature: number;
  numPredict: number;
  retries: number;
  concurrency: number;
  charsPerFile: number;
  charsTotal: number;
  vocabShortlist: number;
  cacheDir: string;
  anthropicKey?: string;
}

export const defaults: Config = {
  provider: "ollama",
  ollamaUrl: "http://localhost:11434",
  model: "qwen2.5-coder:14b",
  numCtx: 8192,
  keepAlive: "30m",
  temperature: 0.15,
  numPredict: 900,
  retries: 3,
  concurrency: 3,
  charsPerFile: 6000,
  charsTotal: 16000,
  vocabShortlist: 32,
  cacheDir: ".landscape-cache",
};

/* ────────────────────────────────────────────────────────────────
   Cache — the biggest single win after keep-alive.
   Re-adding a lab, or tweaking one field, should cost nothing.
   ──────────────────────────────────────────────────────────────── */

const mem = new Map<string, unknown>();

export const cacheKey = (parts: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

export async function cacheGet<T>(cfg: Config, key: string): Promise<T | null> {
  if (mem.has(key)) return mem.get(key) as T;
  try {
    const raw = await readFile(join(cfg.cacheDir, key + ".json"), "utf8");
    const val = JSON.parse(raw) as T;
    mem.set(key, val);
    return val;
  } catch { return null; }
}

export async function cacheSet(cfg: Config, key: string, value: unknown): Promise<void> {
  mem.set(key, value);
  try {
    await mkdir(cfg.cacheDir, { recursive: true });
    await writeFile(join(cfg.cacheDir, key + ".json"), JSON.stringify(value));
  } catch { /* cache is an optimisation, never a hard dependency */ }
}

/* ────────────────────────────────────────────────────────────────
   Concurrency — N labs sequentially is N times the latency for no
   reason. Ollama serves parallel requests; set OLLAMA_NUM_PARALLEL
   to at least this value.
   ──────────────────────────────────────────────────────────────── */

export async function mapLimit<T, R>(
  items: T[], limit: number, fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ────────────────────────────────────────────────────────────────
   Providers
   ──────────────────────────────────────────────────────────────── */

export interface GenOptions { schema?: object; json?: boolean; maxTokens?: number; }

async function ollamaGenerate(cfg: Config, system: string, prompt: string, o: GenOptions): Promise<string> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    stream: false,
    keep_alive: cfg.keepAlive,
    options: {
      temperature: cfg.temperature,
      num_ctx: cfg.numCtx,
      num_predict: o.maxTokens ?? cfg.numPredict,
    },
  };
  if (o.schema) body.format = o.schema;
  else if (o.json) body.format = "json";

  const res = await fetch(cfg.ollamaUrl + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
}

async function anthropicGenerate(cfg: Config, system: string, prompt: string, o: GenOptions): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.anthropicKey ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: o.maxTokens ?? 1400,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Anthropic API returned ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

export const generate = (cfg: Config, system: string, prompt: string, o: GenOptions = {}): Promise<string> =>
  cfg.provider === "anthropic"
    ? anthropicGenerate(cfg, system, prompt, o)
    : ollamaGenerate(cfg, system, prompt, o);

/** Salvage JSON from a model that added fences, prose, or a reasoning block. */
export function parseJson<T>(raw: string): T {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  t = t.replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("no JSON object in response");
  return JSON.parse(t.slice(s, e + 1)) as T;
}

export async function listModels(cfg: Config): Promise<string[]> {
  const res = await fetch(cfg.ollamaUrl + "/api/tags", { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const data = (await res.json()) as { models?: { name: string }[] };
  const skip = ["vision", "image", "embed", "lora"];
  return (data.models ?? []).map((m) => m.name).filter((n) => !skip.some((s) => n.toLowerCase().includes(s)));
}

/** Load the model now so the first real request doesn't pay for it. */
export async function warmup(cfg: Config): Promise<void> {
  if (cfg.provider !== "ollama") return;
  await fetch(cfg.ollamaUrl + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model, messages: [{ role: "user", content: "ok" }],
      stream: false, keep_alive: cfg.keepAlive, options: { num_predict: 1 },
    }),
    signal: AbortSignal.timeout(300_000),
  }).catch(() => undefined);
}
