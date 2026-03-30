/**
 * Merge the base (real) fine-tuning examples with synthetic augmentation.
 *
 * Reads:
 *   output/fine-tuning/train.jsonl      — real public records (14 examples)
 *   output/fine-tuning/eval.jsonl       — real eval records   (3 examples)
 *   output/fine-tuning/synthetic.jsonl  — Claude Haiku generated (33 examples)
 *
 * Writes:
 *   output/fine-tuning/combined-train.jsonl  — real train + synthetic (80% of synthetic)
 *   output/fine-tuning/combined-eval.jsonl   — real eval + synthetic holdout (20%)
 *   output/fine-tuning/manifest-combined.json
 *
 * Usage:
 *   npx tsx examples/merge-fine-tuning-datasets.ts [--split 0.8] [--output dir]
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

interface CliArgs {
  outputDir: string;
  splitRatio: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    outputDir: resolve(process.cwd(), 'output/fine-tuning'),
    splitRatio: 0.8,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--output': args.outputDir = resolve(argv[++i]); break;
      case '--split': args.splitRatio = Number(argv[++i]); break;
    }
  }
  return args;
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function countEngagementTypes(lines: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of lines) {
    const messages = (line as { messages: Array<{ role: string; content: string }> }).messages;
    const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
    // Heuristic: look for engagement type signal in the prompt
    let eng = 'UNKNOWN';
    if (/phone call|call transcript|phone support/i.test(userMsg)) eng = 'CALL';
    else if (/email thread|email from|email chain/i.test(userMsg)) eng = 'EMAIL';
    else if (/ticket|support request|issue #/i.test(userMsg)) eng = 'TICKET';
    else if (/chat session|live chat|chat transcript/i.test(userMsg)) eng = 'CHAT';
    counts[eng] = (counts[eng] ?? 0) + 1;
  }
  return counts;
}

function countPolarities(lines: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of lines) {
    const messages = (line as { messages: Array<{ role: string; content: string }> }).messages;
    const assistantMsg = messages.find((m) => m.role === 'assistant')?.content ?? '{}';
    try {
      const parsed = JSON.parse(assistantMsg) as { overallEndUserSentiment?: { polarity?: string } };
      const polarity = parsed.overallEndUserSentiment?.polarity ?? 'UNKNOWN';
      counts[polarity] = (counts[polarity] ?? 0) + 1;
    } catch {
      counts['PARSE_ERROR'] = (counts['PARSE_ERROR'] ?? 0) + 1;
    }
  }
  return counts;
}

function main() {
  const args = parseArgs(process.argv);

  const trainPath = resolve(args.outputDir, 'train.jsonl');
  const evalPath = resolve(args.outputDir, 'eval.jsonl');
  const syntheticPath = resolve(args.outputDir, 'synthetic.jsonl');

  const realTrain = readJsonl(trainPath);
  const realEval = readJsonl(evalPath);
  const synthetic = readJsonl(syntheticPath);

  console.log(`Real train:     ${realTrain.length} examples`);
  console.log(`Real eval:      ${realEval.length} examples`);
  console.log(`Synthetic:      ${synthetic.length} examples`);

  // Deterministic shuffle of synthetic examples by index
  const synthTrain = synthetic.slice(0, Math.round(synthetic.length * args.splitRatio));
  const synthEval = synthetic.slice(Math.round(synthetic.length * args.splitRatio));

  const combinedTrain = [...realTrain, ...synthTrain];
  const combinedEval = [...realEval, ...synthEval];

  console.log(`\nCombined train: ${combinedTrain.length} examples (${realTrain.length} real + ${synthTrain.length} synthetic)`);
  console.log(`Combined eval:  ${combinedEval.length} examples (${realEval.length} real + ${synthEval.length} synthetic)`);
  console.log(`Total:          ${combinedTrain.length + combinedEval.length} examples`);

  // Distribution analysis
  const trainEngTypes = countEngagementTypes(combinedTrain);
  const trainPolarities = countPolarities(combinedTrain);

  console.log('\nEngagement type distribution (train):');
  for (const [k, v] of Object.entries(trainEngTypes).sort()) {
    console.log(`  ${k}: ${v}`);
  }

  console.log('\nPolarity distribution (train):');
  for (const [k, v] of Object.entries(trainPolarities).sort()) {
    console.log(`  ${k}: ${v}`);
  }

  // Validate coverage
  const missingPolarities = ['VERY_NEGATIVE', 'NEGATIVE', 'NEUTRAL', 'POSITIVE', 'VERY_POSITIVE'].filter(
    (p) => !trainPolarities[p] || trainPolarities[p] === 0,
  );
  if (missingPolarities.length > 0) {
    console.warn(`\nWARN: Missing polarity coverage: ${missingPolarities.join(', ')}`);
  } else {
    console.log('\nAll 5 polarity buckets covered.');
  }

  const toJsonl = (lines: unknown[]) =>
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

  const combinedTrainPath = resolve(args.outputDir, 'combined-train.jsonl');
  const combinedEvalPath = resolve(args.outputDir, 'combined-eval.jsonl');
  const manifestPath = resolve(args.outputDir, 'manifest-combined.json');

  writeFileSync(combinedTrainPath, toJsonl(combinedTrain));
  writeFileSync(combinedEvalPath, toJsonl(combinedEval));
  writeFileSync(manifestPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalExamples: combinedTrain.length + combinedEval.length,
    trainExamples: combinedTrain.length,
    evalExamples: combinedEval.length,
    realTrainExamples: realTrain.length,
    syntheticTrainExamples: synthTrain.length,
    realEvalExamples: realEval.length,
    syntheticEvalExamples: synthEval.length,
    splitRatio: args.splitRatio,
    engagementTypeDistribution: trainEngTypes,
    polarityDistribution: trainPolarities,
  }, null, 2));

  console.log(`\nWrote:`);
  console.log(`  ${combinedTrainPath}`);
  console.log(`  ${combinedEvalPath}`);
  console.log(`  ${manifestPath}`);
  console.log(`\nReady for fine-tuning:`);
  console.log(`  OpenAI: openai api fine_tuning.jobs.create -t ${combinedTrainPath} -v ${combinedEvalPath} -m gpt-4o-mini`);
  console.log(`  Axolotl: update docs/axolotl-qlora.yml path → combined-train.jsonl, then: axolotl train docs/axolotl-qlora.yml`);
}

main();
