import { resolve } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { runGoldLabelValidation, formatValidationReport } from '../src/validation/run-gold-label-validation';
import { StubCanonicalAnalysisEngine, RlmCanonicalAnalysisEngine } from '../src/rlm/engine';
import { resolveProviderProfileFromEnv } from '../src/rlm/provider-profile';
import { canonicalExtractionSchema } from '../src/contracts/analysis';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';
import { TenantPackDraft } from '../src/contracts';

interface CliArgs {
  tenantPackPath: string;
  dryRun: boolean;
  outputDir: string;
  concurrency: number;
  calibrate: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    tenantPackPath: resolve(process.cwd(), 'fixtures/tenant-pack.support.acme.json'),
    dryRun: false,
    outputDir: resolve(process.cwd(), 'output', 'gold-label-validation'),
    concurrency: 1,
    calibrate: false,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--tenant-pack': args.tenantPackPath = resolve(argv[++i]); break;
      case '--dry-run': args.dryRun = true; break;
      case '--output': args.outputDir = resolve(argv[++i]); break;
      case '--concurrency': args.concurrency = Number(argv[++i]); break;
      case '--calibrate': args.calibrate = true; break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  const engine = args.dryRun
    ? new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
      overallEndUserSentiment: {
        polarity: 'NEGATIVE',
        intensity: 0.7,
        confidence: 0.85,
        rationale: 'Dry-run stub: moderate negative sentiment detected.',
      },
      aspectSentiments: [],
      canonicalEvents: [{
        type: 'FRUSTRATION_ONSET',
        actorRole: 'END_USER',
        confidence: 0.8,
        rationale: 'Stub frustration onset.',
        businessImpact: 'HIGH',
        evidence: [{ turnId: 't1', speakerRole: 'END_USER', quote: 'stub' }],
      }],
      canonicalKeyMoments: [{
        type: 'FRUSTRATION_ONSET',
        actorRole: 'END_USER',
        startTurnId: 't1',
        endTurnId: 't1',
        confidence: 0.8,
        rationale: 'Stub key moment.',
        businessImpact: 'HIGH',
        evidence: [{ turnId: 't1', speakerRole: 'END_USER', quote: 'stub' }],
      }],
      summary: 'Dry-run stub analysis.',
      review: { state: 'VERIFIED', reasons: [], comments: [], history: [] },
    }))
    : new RlmCanonicalAnalysisEngine(resolveProviderProfileFromEnv(process.env));

  console.log(`Running gold-label validation (${args.dryRun ? 'dry-run' : 'live'})...`);
  console.log(`Engine: ${args.dryRun ? 'StubCanonicalAnalysisEngine' : 'RlmCanonicalAnalysisEngine'}`);

  const { summary, records } = await runGoldLabelValidation({
    engine,
    tenantPack: tenantPackFixture as TenantPackDraft,
    concurrency: args.concurrency,
    sentimentScoringConfig: args.calibrate
      ? {
        enabled: true,
        defaultScore100Offset: 0,
        byEngagementType: { EMAIL: -3 },
        byPolarity: {},
        byEngagementTypeAndPolarity: {},
      }
      : undefined,
  });

  const report = formatValidationReport(summary);
  console.log('\n' + report);

  // Print error details inline
  const errorRecords = records.filter((r) => r.status === 'ERROR');
  if (errorRecords.length > 0) {
    console.log('\n  ERRORS');
    for (const r of errorRecords) {
      console.log(`    ${r.recordId} (${r.engagementType}): ${r.errorMessage ?? 'unknown error'}`);
    }
  }

  mkdirSync(args.outputDir, { recursive: true });
  writeFileSync(resolve(args.outputDir, 'validation-summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(resolve(args.outputDir, 'validation-records.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n'));
  writeFileSync(resolve(args.outputDir, 'validation-diagnostics.json'), JSON.stringify(summary.diagnostics, null, 2));
  writeFileSync(resolve(args.outputDir, 'validation-worst-records.json'), JSON.stringify(summary.worstRecords, null, 2));

  console.log(`\nResults written to ${args.outputDir}/`);
}

main().catch(console.error);
