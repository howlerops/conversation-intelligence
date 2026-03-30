import { resolve } from 'path';
import { runTenantDataValidation } from '../src/validation/tenant-data-validation';
import { StubCanonicalAnalysisEngine } from '../src/rlm/engine';
import { RlmCanonicalAnalysisEngine } from '../src/rlm/engine';
import { resolveProviderProfileFromEnv } from '../src/rlm/provider-profile';
import { canonicalExtractionSchema } from '../src/contracts/analysis';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';
import { TenantPackDraft } from '../src/contracts';

interface CliArgs {
  inputPath: string;
  tenantId: string;
  tenantPackPath: string;
  maxRecords?: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    inputPath: argv[2] ?? '',
    tenantId: 'tenant_acme',
    tenantPackPath: resolve(process.cwd(), 'fixtures/tenant-pack.support.acme.json'),
    dryRun: false,
  };

  for (let i = 3; i < argv.length; i++) {
    switch (argv[i]) {
      case '--tenant-id': args.tenantId = argv[++i]; break;
      case '--tenant-pack': args.tenantPackPath = resolve(argv[++i]); break;
      case '--max-records': args.maxRecords = Number(argv[++i]); break;
      case '--dry-run': args.dryRun = true; break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.inputPath) {
    console.error('Usage: tsx examples/run-tenant-data-validation.ts <input-path> [--tenant-id ID] [--dry-run]');
    process.exit(1);
  }

  const engine = args.dryRun
    ? new StubCanonicalAnalysisEngine(canonicalExtractionSchema.parse({
      overallEndUserSentiment: {
        polarity: 'NEUTRAL',
        intensity: 0.5,
        confidence: 0.8,
        rationale: 'Dry-run stub sentiment.',
      },
      aspectSentiments: [],
      canonicalEvents: [],
      canonicalKeyMoments: [],
      summary: 'Dry-run analysis.',
      review: { state: 'VERIFIED', reasons: [], comments: [], history: [] },
    }))
    : new RlmCanonicalAnalysisEngine(resolveProviderProfileFromEnv(process.env));

  console.log(`Running tenant data validation (${args.dryRun ? 'dry-run' : 'live'})...`);
  console.log(`Input: ${args.inputPath}`);
  console.log(`Tenant: ${args.tenantId}`);

  const summary = await runTenantDataValidation(
    { inputPath: resolve(args.inputPath), tenantId: args.tenantId },
    { engine, tenantPack: tenantPackFixture as TenantPackDraft },
  );

  console.log('\nValidation Summary:');
  console.log(JSON.stringify({
    totalRecords: summary.totalRecords,
    matched: summary.matched,
    diverged: summary.diverged,
    skipped: summary.skipped,
    errors: summary.errors,
    averageDeltaScore100: summary.averageDeltaScore100,
    withinFivePointsRate: summary.withinFivePointsRate,
    byEngagementType: summary.byEngagementType,
  }, null, 2));
}

main().catch(console.error);
