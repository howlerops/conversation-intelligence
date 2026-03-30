import { readFile } from 'fs/promises';
import { resolve } from 'path';
import {
  generateBenchmarkAnnotationDraftReport,
  loadBenchmarkAnnotationCandidates,
  resolveProviderProfileFromEnv,
  RlmCanonicalAnalysisEngine,
  writeBenchmarkAnnotationDraftArtifacts,
} from '../src';

interface CliArgs {
  sourcePath: string;
  outputDir: string;
  tenantPackPath: string;
  tenantPackPathsByUseCase: Record<string, string>;
  trials: number;
  concurrency: number;
  perRecordTimeoutMs?: number;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length < 2) {
    throw new Error('Usage: tsx examples/draft-annotate-benchmark-candidates.ts <annotation-candidates-path> <output-dir> [--tenant-pack PATH] [--tenant-pack-for-use-case USE_CASE=PATH]... [--trials N] [--concurrency N] [--per-record-timeout-ms N]');
  }

  const args: CliArgs = {
    sourcePath: argv[0],
    outputDir: argv[1],
    tenantPackPath: 'fixtures/tenant-pack.support.acme.json',
    tenantPackPathsByUseCase: {},
    trials: 1,
    concurrency: 1,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--tenant-pack':
        args.tenantPackPath = argv[index + 1] ?? args.tenantPackPath;
        index += 1;
        break;
      case '--tenant-pack-for-use-case': {
        const raw = argv[index + 1] ?? '';
        const delimiter = raw.indexOf('=');
        if (delimiter <= 0) {
          throw new Error(`Invalid --tenant-pack-for-use-case value: ${raw}`);
        }
        const useCase = raw.slice(0, delimiter);
        const path = raw.slice(delimiter + 1);
        args.tenantPackPathsByUseCase[useCase] = path;
        index += 1;
        break;
      }
      case '--trials':
        args.trials = Math.max(1, Number(argv[index + 1] ?? '1'));
        index += 1;
        break;
      case '--concurrency':
        args.concurrency = Math.max(1, Number(argv[index + 1] ?? '1'));
        index += 1;
        break;
      case '--per-record-timeout-ms':
        args.perRecordTimeoutMs = Math.max(1, Number(argv[index + 1] ?? '1'));
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sourcePath = resolve(args.sourcePath);
  const outputDir = resolve(args.outputDir);
  const defaultTenantPackPath = resolve(args.tenantPackPath);
  const tenantPackPathsByUseCase = Object.fromEntries(
    Object.entries(args.tenantPackPathsByUseCase).map(([useCase, path]) => [useCase, resolve(path)]),
  );
  const packCache = new Map<string, unknown>();
  const candidates = await loadBenchmarkAnnotationCandidates(sourcePath);
  const providerProfile = resolveProviderProfileFromEnv(process.env);
  const engine = new RlmCanonicalAnalysisEngine(providerProfile);

  const report = await generateBenchmarkAnnotationDraftReport(candidates, {
    engine,
    sourcePath,
    defaultTenantPackPath,
    tenantPackPathsByUseCase,
    trialsPerCandidate: args.trials,
    concurrency: args.concurrency,
    perRecordTimeoutMs: args.perRecordTimeoutMs,
    resolveTenantPack: async (candidate) => {
      const resolvedPath = tenantPackPathsByUseCase[candidate.useCase] ?? defaultTenantPackPath;
      if (!packCache.has(resolvedPath)) {
        packCache.set(resolvedPath, JSON.parse(await readFile(resolvedPath, 'utf8')));
      }
      return packCache.get(resolvedPath);
    },
  });
  const artifacts = await writeBenchmarkAnnotationDraftArtifacts(outputDir, report);

  console.log(JSON.stringify({
    outputDir: artifacts.outputDir,
    summaryPath: artifacts.summaryPath,
    reportPath: artifacts.reportPath,
    draftsPath: artifacts.draftsPath,
    markdownPath: artifacts.markdownPath,
    summary: report.summary,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
