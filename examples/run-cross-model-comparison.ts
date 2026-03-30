import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import {
  ModelTrialResult,
  buildCrossModelComparison,
  formatComparisonTable,
  modelTrialResultSchema,
} from '../src/validation/cross-model-comparison';
import { E2eBenchmarkSummary } from '../src/validation/e2e-benchmark';

const modelConfigSchema = z.object({
  modelId: z.string().min(1),
  modelName: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  apiKey: z.string().optional(),
  apiBase: z.string().optional(),
});

interface CliArgs {
  suitePath: string;
  outputDir: string;
  modelsPath: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    suitePath: argv[2] ?? '',
    outputDir: argv[3] ?? '',
    modelsPath: resolve(process.cwd(), 'fixtures/benchmarks/model-configs-sample.json'),
    dryRun: false,
  };

  for (let i = 4; i < argv.length; i++) {
    switch (argv[i]) {
      case '--models': args.modelsPath = resolve(argv[++i]); break;
      case '--dry-run': args.dryRun = true; break;
    }
  }
  return args;
}

function generateDryRunResult(modelConfig: z.infer<typeof modelConfigSchema>, seed: number): ModelTrialResult {
  const variance = (seed * 2654435761) % 20;
  const baseAccuracy = 3.0 + variance / 4;
  const baseDuration = 500 + variance * 50;

  const summary: E2eBenchmarkSummary = {
    totalRecords: 50,
    bySource: {},
    byEngagementType: {},
    byQueue: {},
    byTranscriptLengthBucket: {},
    overall: {
      total: 50,
      completed: 48 + (variance % 3),
      failed: 2 - (variance % 3),
      compared: 45,
      reviewCount: 3 + (variance % 5),
      uncertainCount: 1 + (variance % 3),
      averageDurationMs: baseDuration,
      p95DurationMs: baseDuration * 2.5,
      averageDeltaScore100: baseAccuracy,
      averageDeltaScore5: baseAccuracy / 5,
      exactScore5MatchRate: 0.70 + variance / 100,
      withinFivePointsRate: 0.80 + variance / 200,
      reviewStateMatchRate: 0.85 + variance / 200,
    },
  };

  return modelTrialResultSchema.parse({
    modelId: modelConfig.modelId,
    modelName: modelConfig.modelName,
    provider: modelConfig.provider,
    apiBase: modelConfig.apiBase,
    benchmarkSummary: summary,
    runAt: new Date().toISOString(),
    durationMs: 30000 + variance * 1000,
  });
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.suitePath || !args.outputDir) {
    console.error('Usage: tsx examples/run-cross-model-comparison.ts <suite-path> <output-dir> [--models PATH] [--dry-run]');
    process.exit(1);
  }

  const rawConfigs = JSON.parse(readFileSync(args.modelsPath, 'utf8'));
  const modelConfigs = z.array(modelConfigSchema).parse(rawConfigs);

  console.log(`Comparing ${modelConfigs.length} models (${args.dryRun ? 'dry-run' : 'live'})...`);

  const results: ModelTrialResult[] = [];

  for (let i = 0; i < modelConfigs.length; i++) {
    const config = modelConfigs[i];
    console.log(`  Running: ${config.modelName} (${config.provider})...`);

    if (args.dryRun) {
      results.push(generateDryRunResult(config, i + 1));
    } else {
      console.log(`  Live mode would spawn: CI_RLM_MODEL=${config.model} tsx examples/run-e2e-benchmark.ts ...`);
      console.log('  Skipping — live mode requires API keys and benchmark suite.');
      continue;
    }
  }

  if (results.length === 0) {
    console.error('No results collected. Use --dry-run for synthetic results.');
    process.exit(1);
  }

  const comparison = buildCrossModelComparison('cross-model', results);
  const table = formatComparisonTable(comparison);

  mkdirSync(resolve(args.outputDir), { recursive: true });
  writeFileSync(resolve(args.outputDir, 'comparison.json'), JSON.stringify(comparison, null, 2));
  writeFileSync(resolve(args.outputDir, 'comparison.md'), table);

  console.log('\n' + table);
  console.log(`\nResults written to ${args.outputDir}/`);
}

main().catch(console.error);
