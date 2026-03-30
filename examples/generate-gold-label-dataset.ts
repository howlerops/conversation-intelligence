import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  generateSyntheticGoldLabelDataset,
  validateGoldLabelCoverage,
} from '../src/validation/synthetic-gold-label-generator';
import { summarizeGoldLabelDataset, loadGoldLabelDataset } from '../src/validation/gold-label-toolkit';

interface CliArgs {
  count: number;
  seed: number;
  output: string;
  validate: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    count: 120,
    seed: 42,
    output: resolve(process.cwd(), 'fixtures/benchmarks/gold-label-reviewed-100.jsonl'),
    validate: false,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--count': args.count = Number(argv[++i]); break;
      case '--seed': args.seed = Number(argv[++i]); break;
      case '--output': args.output = resolve(argv[++i]); break;
      case '--validate': args.validate = true; break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log(`Generating ${args.count} gold-label records with seed=${args.seed}...`);
  const records = generateSyntheticGoldLabelDataset({
    count: args.count,
    seed: args.seed,
  });

  const lines = records.map((r) => JSON.stringify(r));
  writeFileSync(args.output, lines.join('\n') + '\n');
  console.log(`Wrote ${records.length} records to ${args.output}`);

  const summary = summarizeGoldLabelDataset(records);
  console.log('\nDataset summary:');
  console.log(JSON.stringify(summary, null, 2));

  const coverage = validateGoldLabelCoverage(records);
  console.log(`\nCoverage valid: ${coverage.valid}`);
  if (coverage.issues.length > 0) {
    console.log('Issues:');
    for (const issue of coverage.issues) {
      console.log(`  - ${issue}`);
    }
  }

  if (args.validate && existsSync(args.output)) {
    console.log('\nReloading and re-validating from disk...');
    const loaded = await loadGoldLabelDataset(args.output);
    console.log(`Loaded ${loaded.length} records from ${args.output}`);
    const revalidated = summarizeGoldLabelDataset(loaded);
    console.log(`Statistically significant: ${revalidated.statisticallySignificant}`);
  }
}

main().catch(console.error);
