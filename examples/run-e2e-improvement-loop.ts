import { appendFile, mkdir, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import {
  E2eBenchmarkSummary,
  loadE2eBenchmarkSuiteFromPath,
  recommendSentimentScoringConfigFromDataset,
  resolveProviderProfileFromEnv,
  RlmCanonicalAnalysisEngine,
  runE2eBenchmarkSuite,
  writeE2eBenchmarkArtifacts,
} from '../src';

interface CliArgs {
  suitePath: string;
  outputDir: string;
  reviewedDatasetPath?: string;
  concurrency?: number;
  maxRecordsPerSource?: number;
  perRecordTimeoutMs?: number;
  progressLogPath?: string;
  verbose: boolean;
}

interface GateSummary {
  metExpectations: boolean;
  failures: string[];
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length < 2) {
    throw new Error('Usage: tsx examples/run-e2e-improvement-loop.ts <suite-path> <output-dir> [--reviewed-dataset PATH] [--concurrency N] [--max-records-per-source N] [--per-record-timeout-ms N] [--progress-log PATH] [--verbose]');
  }

  const input: CliArgs = {
    suitePath: argv[0],
    outputDir: argv[1],
    verbose: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--reviewed-dataset':
        input.reviewedDatasetPath = argv[index + 1];
        index += 1;
        break;
      case '--concurrency':
        input.concurrency = Number(argv[index + 1]);
        index += 1;
        break;
      case '--max-records-per-source':
        input.maxRecordsPerSource = Number(argv[index + 1]);
        index += 1;
        break;
      case '--per-record-timeout-ms':
        input.perRecordTimeoutMs = Number(argv[index + 1]);
        index += 1;
        break;
      case '--progress-log':
        input.progressLogPath = argv[index + 1];
        index += 1;
        break;
      case '--verbose':
        input.verbose = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return input;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const suite = await loadE2eBenchmarkSuiteFromPath(resolve(args.suitePath));
  const providerProfile = resolveProviderProfileFromEnv(process.env);
  const engine = new RlmCanonicalAnalysisEngine(providerProfile);
  const outputDir = resolve(args.outputDir);
  await mkdir(outputDir, { recursive: true });
  const progressLogPath = resolve(args.progressLogPath ?? join(outputDir, 'progress.jsonl'));

  if (args.verbose) {
    attachVerboseRlmLogging(engine);
  }

  const baseline = await runNamedBenchmark('baseline', suite, engine, progressLogPath, {
    concurrency: args.concurrency,
    maxRecordsPerSource: args.maxRecordsPerSource,
    perRecordTimeoutMs: args.perRecordTimeoutMs,
  });
  const baselineArtifacts = await writeE2eBenchmarkArtifacts(join(outputDir, 'baseline'), baseline);

  let recommendedCalibrationPath: string | null = null;
  let calibrated: Awaited<ReturnType<typeof runE2eBenchmarkSuite>> | null = null;
  let calibratedArtifacts: Awaited<ReturnType<typeof writeE2eBenchmarkArtifacts>> | null = null;

  if (args.reviewedDatasetPath) {
    const recommendation = await recommendSentimentScoringConfigFromDataset(resolve(args.reviewedDatasetPath), {
      minimumSampleSize: 10,
      minimumSampleSizePerEngagementType: 5,
    });

    if (recommendation.recommendedConfig.enabled) {
      recommendedCalibrationPath = join(outputDir, 'recommended-sentiment-calibration.json');
      await writeFile(recommendedCalibrationPath, JSON.stringify(recommendation.recommendedConfig, null, 2));
      calibrated = await runNamedBenchmark('calibrated', suite, engine, progressLogPath, {
        concurrency: args.concurrency,
        maxRecordsPerSource: args.maxRecordsPerSource,
        perRecordTimeoutMs: args.perRecordTimeoutMs,
        calibrationConfigPath: recommendedCalibrationPath,
      });
      calibratedArtifacts = await writeE2eBenchmarkArtifacts(join(outputDir, 'calibrated'), calibrated);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    suitePath: resolve(args.suitePath),
    reviewedDatasetPath: args.reviewedDatasetPath ? resolve(args.reviewedDatasetPath) : null,
    providerProfile: {
      provider: providerProfile.provider,
      model: providerProfile.model,
      apiBase: providerProfile.apiBase ?? null,
    },
    progressLogPath,
    perRecordTimeoutMs: args.perRecordTimeoutMs ?? null,
    baseline: {
      summary: baseline.summary,
      artifacts: baselineArtifacts,
      gates: evaluateQualityGates(baseline.summary),
    },
    calibrated: calibrated
      ? {
        summary: calibrated.summary,
        artifacts: calibratedArtifacts,
        gates: evaluateQualityGates(calibrated.summary),
      }
      : null,
    recommendedCalibrationPath,
  };

  const reportPath = join(outputDir, 'loop-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportPath, report }, null, 2));
}

function evaluateQualityGates(summary: E2eBenchmarkSummary): GateSummary {
  const failures: string[] = [];
  const overall = summary.overall;

  const failureRate = overall.total === 0 ? 0 : overall.failed / overall.total;
  const reviewRate = overall.completed === 0 ? 0 : overall.reviewCount / overall.completed;
  const uncertainRate = overall.completed === 0 ? 0 : overall.uncertainCount / overall.completed;

  if (failureRate > 0.05) {
    failures.push(`failureRate=${failureRate.toFixed(3)} exceeds 0.050`);
  }
  if (reviewRate > 0.40) {
    failures.push(`reviewRate=${reviewRate.toFixed(3)} exceeds 0.400`);
  }
  if (uncertainRate > 0.20) {
    failures.push(`uncertainRate=${uncertainRate.toFixed(3)} exceeds 0.200`);
  }
  if (typeof overall.averageDeltaScore100 === 'number' && overall.averageDeltaScore100 > 5) {
    failures.push(`averageDeltaScore100=${overall.averageDeltaScore100.toFixed(2)} exceeds 5.00`);
  }
  if (typeof overall.withinFivePointsRate === 'number' && overall.withinFivePointsRate < 0.80) {
    failures.push(`withinFivePointsRate=${overall.withinFivePointsRate.toFixed(3)} is below 0.800`);
  }

  for (const [engagementType, bucket] of Object.entries(summary.byEngagementType)) {
    if (bucket.compared < 3) {
      continue;
    }
    if (typeof bucket.averageDeltaScore100 === 'number' && bucket.averageDeltaScore100 > 5) {
      failures.push(`${engagementType}.averageDeltaScore100=${bucket.averageDeltaScore100.toFixed(2)} exceeds 5.00`);
    }
    if (typeof bucket.withinFivePointsRate === 'number' && bucket.withinFivePointsRate < 0.75) {
      failures.push(`${engagementType}.withinFivePointsRate=${bucket.withinFivePointsRate.toFixed(3)} is below 0.750`);
    }
  }

  return {
    metExpectations: failures.length === 0,
    failures,
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function runNamedBenchmark(
  name: 'baseline' | 'calibrated',
  suite: Awaited<ReturnType<typeof loadE2eBenchmarkSuiteFromPath>>,
  engine: RlmCanonicalAnalysisEngine,
  progressLogPath: string,
  options: {
    concurrency?: number;
    maxRecordsPerSource?: number;
    perRecordTimeoutMs?: number;
    calibrationConfigPath?: string;
  },
) {
  return runE2eBenchmarkSuite(suite, {
    engine,
    concurrency: options.concurrency,
    maxRecordsPerSource: options.maxRecordsPerSource,
    perRecordTimeoutMs: options.perRecordTimeoutMs,
    calibrationConfigPath: options.calibrationConfigPath,
    onRecordStart: async (update) => {
      await appendFile(progressLogPath, `${JSON.stringify({
        benchmark: name,
        type: 'record_start',
        at: new Date().toISOString(),
        index: update.index + 1,
        total: update.total,
        sourceId: update.sourceId,
        recordId: update.recordId,
        pipelineId: update.pipelineId ?? null,
        engagementType: update.engagementType,
        queue: update.queue ?? null,
      })}\n`);
      console.error(`[${name}] [${update.index + 1}/${update.total}] start ${update.engagementType} ${update.recordId}`);
    },
    onRecordComplete: async (update) => {
      await appendFile(progressLogPath, `${JSON.stringify({
        benchmark: name,
        type: 'record_complete',
        at: new Date().toISOString(),
        index: update.index + 1,
        total: update.total,
        sourceId: update.sourceId,
        recordId: update.recordId,
        status: update.result.status,
        durationMs: update.result.durationMs,
        reviewState: update.result.reviewState ?? null,
        deltaScore100: update.result.deltaScore100 ?? null,
        deltaScore5: update.result.deltaScore5 ?? null,
        errorMessage: update.result.errorMessage ?? null,
      })}\n`);
      const suffix = update.result.errorMessage ? ` error=${update.result.errorMessage}` : '';
      console.error(`[${name}] [${update.index + 1}/${update.total}] done ${update.recordId} status=${update.result.status} durationMs=${update.result.durationMs}${suffix}`);
    },
  });
}

function attachVerboseRlmLogging(engine: RlmCanonicalAnalysisEngine): void {
  engine.on('completion_start', (event) => {
    console.error(`[rlm] completion_start model=${event.model} structured=${event.structured} contextLength=${event.contextLength}`);
  });
  engine.on('llm_call', (event) => {
    console.error(`[rlm] llm_call model=${event.model} queryLength=${event.queryLength} contextLength=${event.contextLength}`);
  });
  engine.on('llm_response', (event) => {
    console.error(`[rlm] llm_response model=${event.model} durationMs=${event.duration}`);
  });
  engine.on('retry', (event) => {
    console.error(`[rlm] retry attempt=${event.attempt}/${event.maxRetries} delayMs=${event.delay} error=${event.error}`);
  });
  engine.on('validation_retry', (event) => {
    console.error(`[rlm] validation_retry attempt=${event.attempt}/${event.maxRetries} error=${event.error}`);
  });
  engine.on('error', (event) => {
    console.error(`[rlm] error operation=${event.operation} message=${event.error.message}`);
  });
}
