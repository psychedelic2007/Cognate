/**
 * Where does the time actually go, and which of your models is good enough?
 *
 *   npm run build && node dist/server/bench.js
 *   node dist/server/bench.js --models qwen2.5-coder:14b qwen2.5:7b
 *
 * Reports two things that matter more than raw speed:
 *   vocabulary reuse  — if the model coins synonyms the graph fragments
 *   generic topics    — if it tags everyone "machine learning" every lab
 *                       looks similar to every other and the map is noise
 */
import { defaults, generate, listModels, parseJson, warmup, type Config } from "./provider.js";
import { SYSTEM, labPrompt, labSchema } from "./prompts.js";

const VOCAB = [
  "viral evolution", "protein language models", "antibody escape", "deep mutational scanning",
  "fitness landscapes", "sars cov 2", "influenza", "variant effect prediction", "generative models",
];

const DESC =
  "Our lab builds deep generative models of protein sequences to predict the effects of mutations. " +
  "We developed a variational autoencoder trained on evolutionary sequence data that scores variant " +
  "pathogenicity, and extended it to forecast which mutations in viral surface glycoproteins will " +
  "escape neutralising antibodies before those variants emerge. Recent work applies the same framework " +
  "to influenza H3N2 and to designing antibodies robust to future escape.";

const GENERIC = new Set([
  "machine learning", "biology", "computational biology", "data analysis", "bioinformatics",
  "artificial intelligence", "research", "modeling", "modelling", "deep learning", "science", "genomics",
]);

interface Row {
  model: string; ok: boolean; why?: string; secs: number; ttft?: number;
  topics?: number; reused?: number; generic?: number; labels?: string[]; withEvidence: boolean;
}

async function run(cfg: Config, withEvidence: boolean): Promise<Row> {
  const t0 = performance.now();
  try {
    const prompt = labPrompt("Test PI", "Test Institute", DESC, "", VOCAB, withEvidence);
    const raw = await generate(cfg, SYSTEM, prompt, { schema: labSchema(withEvidence) });
    const data = parseJson<{ topics: { label: string }[] }>(raw);
    const labels = (data.topics ?? []).map((t) => String(t.label).toLowerCase().trim());
    return {
      model: cfg.model, ok: true, secs: (performance.now() - t0) / 1000,
      topics: labels.length,
      reused: labels.filter((l) => VOCAB.includes(l)).length,
      generic: labels.filter((l) => GENERIC.has(l)).length,
      labels, withEvidence,
    };
  } catch (e) {
    return { model: cfg.model, ok: false, why: String(e).slice(0, 110), secs: (performance.now() - t0) / 1000, withEvidence };
  }
}

const pad = (s: string, n: number) => s.padEnd(n);

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--models");
  const base: Config = { ...defaults };

  let models = i >= 0 ? argv.slice(i + 1).filter((a) => !a.startsWith("--")) : [];
  if (!models.length) {
    try { models = await listModels(base); }
    catch { console.log("Ollama is not responding. Start it with: ollama serve"); process.exit(1); }
  }

  console.log(`Testing ${models.length} model(s). Expect 20-60s each on a 14B.\n`);
  const rows: Row[] = [];

  for (const model of models) {
    const cfg = { ...base, model };
    process.stdout.write(`· ${model}\n`);

    // Cold: model not resident. This is what an idle keep_alive costs you.
    const cold = await run(cfg, true);
    // Warm: model already loaded.
    await warmup(cfg);
    const warm = await run(cfg, true);
    // Fast mode: no evidence strings, ~40% fewer generated tokens.
    const fast = await run(cfg, false);

    if (!warm.ok) {
      console.log(`  FAILED — ${warm.why}\n`);
      rows.push(warm);
      continue;
    }
    console.log(`  cold ${cold.secs.toFixed(1)}s · warm ${warm.secs.toFixed(1)}s · fast mode ${fast.secs.toFixed(1)}s`);
    console.log(`  ${warm.topics} topics · ${warm.reused} reused from vocabulary · ${warm.generic} generic`);
    console.log(`  ${warm.labels!.join(", ")}`);
    const saved = cold.secs - warm.secs;
    if (saved > 1) console.log(`  keep_alive saves ${saved.toFixed(1)}s per request after an idle gap`);
    const fastGain = warm.secs > 0 ? (1 - fast.secs / warm.secs) * 100 : 0;
    if (fastGain > 5) console.log(`  fast mode is ${fastGain.toFixed(0)}% quicker`);
    console.log();
    rows.push(warm);
  }

  const good = rows.filter((r) => r.ok);
  if (!good.length) {
    console.log("Nothing usable. Pull a stronger model: ollama pull qwen2.5-coder:14b");
    return;
  }

  console.log("=".repeat(66));
  console.log(pad("model", 26) + pad("secs", 8) + pad("reused", 9) + pad("generic", 9) + "verdict");
  // Vocabulary reuse keeps the graph connected; generic topics make every lab
  // look alike. Both matter more than a few seconds either way.
  good.sort((a, b) => (b.reused! * 2 - b.generic! * 3) - (a.reused! * 2 - a.generic! * 3) || a.secs - b.secs);
  for (const r of good) {
    const verdict = r.generic! >= 2 ? "too generic" : r.reused! === 0 ? "coins synonyms" : "usable";
    console.log(pad(r.model, 26) + pad(r.secs.toFixed(1), 8) + pad(String(r.reused), 9) + pad(String(r.generic), 9) + verdict);
  }
  const best = good[0];
  console.log(`\nUse:  npm start -- --model ${best.model}`);
  if (best.generic! >= 2) {
    console.log("\n!  Even the best model here produced generic topics. Expect inflated");
    console.log("   similarity between unrelated labs. Check the edges by hand.");
  }
  console.log("\nIf cold and warm differ a lot, keep_alive is doing the work — not the language.");
}

void main();
