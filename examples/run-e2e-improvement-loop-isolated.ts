import { mkdir, readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import { z } from 'zod';
import {
  e2eBenchmarkRecordResultSchema,
  E2eBenchmarkSummary,
  recommendSentimentScoringConfigFromDataset,
  TenantAdminSentimentScoring,
} from '../src';

interface CliArgs {
  suitePath: string;
  outputDir: string;
  reviewedDatasetPath?: string;
  calibrationSource: 'auto' | 'reviewed' | 'benchmark';
  concurrency?: number;
  maxRecordsPerSource?: number;
  perRecordTimeoutMs?: number;
  childTimeoutMs?: number;
  verbose: boolean;
}

interface GateSummary {
  metExpectations: boolean;
  failures: string[];
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length < 2) {
    throw new Error('Usage: tsx examples/run-e2e-improvement-loop-isolated.ts <suite-path> <output-dir> [--reviewed-dataset PATH] [--calibration-source auto|reviewed|benchmark] [--concurrency N] [--max-records-per-source N] [--per-record-timeout-ms N] [--child-timeout-ms N] [--verbose]');
  }

  const input: CliArgs = {
    suitePath: argv[0],
    outputDir: argv[1],
    calibrationSource: 'auto',
    verbose: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--reviewed-dataset':
        input.reviewedDatasetPath = argv[index + 1];
        index += 1;
        break;
      case '--calibration-source':
        input.calibrationSource = parseCalibrationSource(argv[index + 1]);
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
      case '--child-timeout-ms':
        input.childTimeoutMs = Number(argv[index + 1]);
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
  const outputDir = resolve(args.outputDir);
  await mkdir(outputDir, { recursive: true });

  const baselineDir = join(outputDir, 'baseline');
  const baseline = await runIsolatedBenchmark('baseline', baselineDir, args);

  let recommendedCalibrationPath: string | null = null;
  let recommendedCalibrationSource: 'reviewed' | 'benchmark' | null = null;
  let calibrated: Awaited<ReturnType<typeof runIsolatedBenchmark>> | null = null;
  const benchmarkRecommendation = recommendSentimentScoringConfigFromBenchmarkRecords(baseline.records);
  const reviewedRecommendation = args.reviewedDatasetPath
    ? await recommendSentimentScoringConfigFromDataset(resolve(args.reviewedDatasetPath), {
      minimumSampleSize: 10,
      minimumSampleSizePerEngagementType: 5,
    })
    : null;

  const recommendedConfig = selectRecommendedCalibrationConfig(args, {
    benchmark: benchmarkRecommendation.recommendedConfig,
    reviewed: reviewedRecommendation?.recommendedConfig ?? null,
  });

  if (recommendedConfig?.config.enabled) {
    recommendedCalibrationPath = join(outputDir, 'recommended-sentiment-calibration.json');
    recommendedCalibrationSource = recommendedConfig.source;
    await writeFile(recommendedCalibrationPath, JSON.stringify(recommendedConfig.config, null, 2));
    calibrated = await runIsolatedBenchmark('calibrated', join(outputDir, 'calibrated'), args, recommendedCalibrationPath);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    suitePath: resolve(args.suitePath),
    reviewedDatasetPath: args.reviewedDatasetPath ? resolve(args.reviewedDatasetPath) : null,
    calibrationSource: args.calibrationSource,
    baseline: {
      summary: baseline.summary,
      metadataPath: baseline.metadataPath,
      recordsPath: baseline.recordsPath,
      gates: evaluateQualityGates(baseline.summary),
      worstRecords: listWorstRecords(baseline.records),
    },
    calibrated: calibrated
      ? {
        summary: calibrated.summary,
        metadataPath: calibrated.metadataPath,
        recordsPath: calibrated.recordsPath,
        gates: evaluateQualityGates(calibrated.summary),
        worstRecords: listWorstRecords(calibrated.records),
      }
      : null,
    recommendedCalibrationPath,
    recommendedCalibrationSource,
    benchmarkRecommendation,
    reviewedRecommendation,
  };

  const reportPath = join(outputDir, 'loop-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportPath, report }, null, 2));
}

async function runIsolatedBenchmark(
  name: 'baseline' | 'calibrated',
  outputDir: string,
  args: CliArgs,
  calibrationConfigPath?: string,
): Promise<{ summary: E2eBenchmarkSummary; metadataPath: string; recordsPath: string; records: z.infer<typeof e2eBenchmarkRecordResultSchema>[] }> {
  await mkdir(outputDir, { recursive: true });

  const childArgs = [
    'examples/run-e2e-benchmark-isolated.ts',
    resolve(args.suitePath),
    outputDir,
    '--concurrency',
    String(args.concurrency ?? 1),
  ];
  if (typeof args.maxRecordsPerSource === 'number') {
    childArgs.push('--max-records-per-source', String(args.maxRecordsPerSource));
  }
  if (typeof args.perRecordTimeoutMs === 'number') {
    childArgs.push('--per-record-timeout-ms', String(args.perRecordTimeoutMs));
  }
  if (typeof args.childTimeoutMs === 'number') {
    childArgs.push('--child-timeout-ms', String(args.childTimeoutMs));
  }
  if (calibrationConfigPath) {
    childArgs.push('--calibration-config', calibrationConfigPath);
  }
  if (args.verbose) {
    childArgs.push('--verbose');
  }

  console.error(`[loop:${name}] starting isolated benchmark`);
  const { exitCode, stderr, stdout } = await runChild(childArgs);
  if (exitCode !== 0) {
    throw new Error(`[loop:${name}] isolated benchmark failed: ${extractFailureMessage(stderr || stdout)}`);
  }

  const metadataPath = join(outputDir, 'metadata.json');
  const summaryPath = join(outputDir, 'summary.json');
  const recordsPath = join(outputDir, 'records.jsonl');
  const summary = JSON.parse(await readFile(summaryPath, 'utf8')).summary as E2eBenchmarkSummary;
  const records = parseBenchmarkRecords(await readFile(recordsPath, 'utf8'));
  return { summary, metadataPath, recordsPath, records };
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

async function runChild(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn('./node_modules/.bin/tsx', args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolveChild) => {
    child.on('exit', (code) => resolveChild(code));
    child.on('error', () => resolveChild(1));
  });

  return { exitCode, stdout, stderr };
}

function extractFailureMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return 'child process failed without output';
  }
  return trimmed.split(/\r?\n/).filter(Boolean).at(-1) ?? trimmed;
}

function parseCalibrationSource(input: string | undefined): CliArgs['calibrationSource'] {
  if (input === 'reviewed' || input === 'benchmark' || input === 'auto') {
    return input;
  }
  throw new Error(`Unknown calibration source: ${input}`);
}

function parseBenchmarkRecords(text: string): z.infer<typeof e2eBenchmarkRecordResultSchema>[] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => e2eBenchmarkRecordResultSchema.parse(JSON.parse(line)));
}

function selectRecommendedCalibrationConfig(
  args: CliArgs,
  input: {
    benchmark: TenantAdminSentimentScoring | null;
    reviewed: TenantAdminSentimentScoring | null;
  },
): { source: 'reviewed' | 'benchmark'; config: TenantAdminSentimentScoring } | null {
  if (args.calibrationSource === 'reviewed') {
    return input.reviewed?.enabled ? { source: 'reviewed', config: input.reviewed } : null;
  }
  if (args.calibrationSource === 'benchmark') {
    return input.benchmark?.enabled ? { source: 'benchmark', config: input.benchmark } : null;
  }
  if (input.benchmark?.enabled) {
    return { source: 'benchmark', config: input.benchmark };
  }
  if (input.reviewed?.enabled) {
    return { source: 'reviewed', config: input.reviewed };
  }
  return null;
}

function recommendSentimentScoringConfigFromBenchmarkRecords(
  records: z.infer<typeof e2eBenchmarkRecordResultSchema>[],
): {
  recommendedConfig: TenantAdminSentimentScoring;
  overall: RecommendationBucket;
  byEngagementType: Partial<Record<'CALL' | 'EMAIL' | 'TICKET' | 'CHAT', RecommendationBucket>>;
  byPolarity: Partial<Record<'VERY_NEGATIVE' | 'NEGATIVE' | 'NEUTRAL' | 'POSITIVE' | 'VERY_POSITIVE', RecommendationBucket>>;
  byEngagementTypeAndPolarity: Partial<Record<'CALL' | 'EMAIL' | 'TICKET' | 'CHAT', Partial<Record<'VERY_NEGATIVE' | 'NEGATIVE' | 'NEUTRAL' | 'POSITIVE' | 'VERY_POSITIVE', RecommendationBucket>>>>;
} {
  const comparable = records.filter((record) => record.status === 'COMPLETED'
    && typeof record.deltaScore100 === 'number'
    && typeof record.sentiment?.score?.score100 === 'number'
    && typeof record.expectedSentiment?.score100 === 'number');

  const overall = buildRecommendationBucket(comparable);
  const byEngagementType = groupRecommendationBuckets(comparable, (record) => record.engagementType === 'UNSPECIFIED' ? null : record.engagementType, 1);
  const byPolarity = groupRecommendationBuckets(comparable, (record) => record.sentiment?.polarity ?? null, 1);
  const byEngagementTypeAndPolarity = Object.fromEntries(
    Object.entries(byEngagementType).map(([engagementType]) => {
      const scopedRecords = comparable.filter((record) => record.engagementType === engagementType);
      return [
        engagementType,
        groupRecommendationBuckets(scopedRecords, (record) => record.sentiment?.polarity ?? null, 1),
      ];
    }),
  ) as ReturnType<typeof recommendSentimentScoringConfigFromBenchmarkRecords>['byEngagementTypeAndPolarity'];

  const recommendedConfig: TenantAdminSentimentScoring = {
    enabled: false,
    defaultScore100Offset: 0,
    byEngagementType: {},
    byPolarity: {},
    byEngagementTypeAndPolarity: {},
  };

  const specificityCandidates = (
    Object.entries(byEngagementTypeAndPolarity) as Array<[
      'CALL' | 'EMAIL' | 'TICKET' | 'CHAT',
      Partial<Record<'VERY_NEGATIVE' | 'NEGATIVE' | 'NEUTRAL' | 'POSITIVE' | 'VERY_POSITIVE', RecommendationBucket>>
    ]>
  ).flatMap(([engagementType, buckets]) => (
    Object.entries(buckets).map(([polarity, bucket]) => ({
      engagementType,
      polarity: polarity as 'VERY_NEGATIVE' | 'NEGATIVE' | 'NEUTRAL' | 'POSITIVE' | 'VERY_POSITIVE',
      bucket,
    }))
  ));

  for (const candidate of specificityCandidates) {
    if (shouldKeepCandidateConfig(comparable, recommendedConfig, {
      engagementType: candidate.engagementType,
      polarity: candidate.polarity,
      offset: candidate.bucket.recommendedScore100Offset,
    })) {
      recommendedConfig.byEngagementTypeAndPolarity[candidate.engagementType] = {
        ...(recommendedConfig.byEngagementTypeAndPolarity[candidate.engagementType] ?? {}),
        [candidate.polarity]: candidate.bucket.recommendedScore100Offset,
      };
    }
  }

  for (const [polarity, bucket] of Object.entries(byPolarity) as Array<[
    'VERY_NEGATIVE' | 'NEGATIVE' | 'NEUTRAL' | 'POSITIVE' | 'VERY_POSITIVE',
    RecommendationBucket,
  ]>) {
    if (shouldKeepCandidateConfig(comparable, recommendedConfig, {
      polarity,
      offset: bucket.recommendedScore100Offset,
    })) {
      recommendedConfig.byPolarity[polarity] = bucket.recommendedScore100Offset;
    }
  }

  recommendedConfig.enabled = hasAnyBenchmarkOffsets(recommendedConfig);

  return {
    recommendedConfig,
    overall,
    byEngagementType,
    byPolarity,
    byEngagementTypeAndPolarity,
  };
}

interface RecommendationBucket {
  sampleSize: number;
  averageSignedDeltaScore100: number;
  recommendedScore100Offset: number;
}

function buildRecommendationBucket(records: z.infer<typeof e2eBenchmarkRecordResultSchema>[]): RecommendationBucket {
  if (records.length === 0) {
    return {
      sampleSize: 0,
      averageSignedDeltaScore100: 0,
      recommendedScore100Offset: 0,
    };
  }

  const signedDeltas = records.map((record) => record.expectedSentiment!.score100 - record.sentiment!.score!.score100);
  const averageSignedDeltaScore100 = Number((signedDeltas.reduce((sum, value) => sum + value, 0) / signedDeltas.length).toFixed(2));

  return {
    sampleSize: records.length,
    averageSignedDeltaScore100,
    recommendedScore100Offset: Math.max(-20, Math.min(20, Math.round(averageSignedDeltaScore100))),
  };
}

function groupRecommendationBuckets<T extends string>(
  records: z.infer<typeof e2eBenchmarkRecordResultSchema>[],
  keyFn: (record: z.infer<typeof e2eBenchmarkRecordResultSchema>) => T | null,
  minimumSampleSize = 2,
): Partial<Record<T, RecommendationBucket>> {
  const buckets = new Map<T, z.infer<typeof e2eBenchmarkRecordResultSchema>[]>();
  for (const record of records) {
    const key = keyFn(record);
    if (!key) {
      continue;
    }
    const bucket = buckets.get(key) ?? [];
    bucket.push(record);
    buckets.set(key, bucket);
  }

  return Object.fromEntries(
    Array.from(buckets.entries())
      .filter(([, bucket]) => bucket.length >= minimumSampleSize)
      .map(([key, bucket]) => [key, buildRecommendationBucket(bucket)]),
  ) as Partial<Record<T, RecommendationBucket>>;
}

function shouldKeepCandidateConfig(
  records: z.infer<typeof e2eBenchmarkRecordResultSchema>[],
  currentConfig: TenantAdminSentimentScoring,
  candidate: {
    engagementType?: 'CALL' | 'EMAIL' | 'TICKET' | 'CHAT';
    polarity: 'VERY_NEGATIVE' | 'NEGATIVE' | 'NEUTRAL' | 'POSITIVE' | 'VERY_POSITIVE';
    offset: number;
  },
): boolean {
  const baselineMetrics = summarizeBenchmarkCalibration(records, currentConfig);
  const nextConfig = structuredClone(currentConfig);

  if (candidate.engagementType) {
    nextConfig.byEngagementTypeAndPolarity[candidate.engagementType] = {
      ...(nextConfig.byEngagementTypeAndPolarity[candidate.engagementType] ?? {}),
      [candidate.polarity]: candidate.offset,
    };
  } else {
    nextConfig.byPolarity[candidate.polarity] = candidate.offset;
  }

  const candidateMetrics = summarizeBenchmarkCalibration(records, nextConfig);
  return candidateMetrics.averageDeltaScore100 < baselineMetrics.averageDeltaScore100 - 0.25
    || (
      candidateMetrics.averageDeltaScore100 <= baselineMetrics.averageDeltaScore100
      && candidateMetrics.withinFivePointsRate > baselineMetrics.withinFivePointsRate
    );
}

function summarizeBenchmarkCalibration(
  records: z.infer<typeof e2eBenchmarkRecordResultSchema>[],
  config: TenantAdminSentimentScoring,
): {
  averageDeltaScore100: number;
  withinFivePointsRate: number;
} {
  if (records.length === 0) {
    return {
      averageDeltaScore100: 0,
      withinFivePointsRate: 0,
    };
  }

  const deltas = records.map((record) => {
    const predicted = applyBenchmarkCalibrationToRecord(record, config);
    return Math.abs(predicted - record.expectedSentiment!.score100);
  });
  const withinFivePointsRate = deltas.filter((delta) => delta <= 5).length / records.length;

  return {
    averageDeltaScore100: Number((deltas.reduce((sum, delta) => sum + delta, 0) / records.length).toFixed(2)),
    withinFivePointsRate: Number(withinFivePointsRate.toFixed(4)),
  };
}

function applyBenchmarkCalibrationToRecord(
  record: z.infer<typeof e2eBenchmarkRecordResultSchema>,
  config: TenantAdminSentimentScoring,
): number {
  const baseScore = record.sentiment!.score!.score100;
  const engagementType = record.engagementType === 'UNSPECIFIED' ? undefined : record.engagementType;
  const polarity = record.sentiment?.polarity;
  const scopedOffset = engagementType && polarity
    ? config.byEngagementTypeAndPolarity[engagementType]?.[polarity]
    : undefined;
  const polarityOffset = polarity ? config.byPolarity[polarity] : undefined;
  const offset = typeof scopedOffset === 'number'
    ? scopedOffset
    : typeof polarityOffset === 'number'
      ? polarityOffset
      : config.defaultScore100Offset;
  return Math.max(0, Math.min(100, Math.round(baseScore + offset)));
}

function hasAnyBenchmarkOffsets(config: TenantAdminSentimentScoring): boolean {
  return config.defaultScore100Offset !== 0
    || Object.values(config.byEngagementType).some((value) => typeof value === 'number' && value !== 0)
    || Object.values(config.byPolarity).some((value) => typeof value === 'number' && value !== 0)
    || Object.values(config.byEngagementTypeAndPolarity).some((bucket) => bucket
      && Object.values(bucket).some((value) => typeof value === 'number' && value !== 0));
}

function listWorstRecords(records: z.infer<typeof e2eBenchmarkRecordResultSchema>[]): Array<{
  recordId: string;
  engagementType: string;
  queue?: string;
  deltaScore100?: number;
  deltaScore5?: number;
  status: string;
  errorMessage?: string;
}> {
  return [...records]
    .sort((left, right) => {
      const leftScore = left.status === 'FAILED' ? Number.POSITIVE_INFINITY : (left.deltaScore100 ?? -1);
      const rightScore = right.status === 'FAILED' ? Number.POSITIVE_INFINITY : (right.deltaScore100 ?? -1);
      return rightScore - leftScore;
    })
    .slice(0, 5)
    .map((record) => ({
      recordId: record.recordId,
      engagementType: record.engagementType,
      queue: record.queue,
      deltaScore100: record.deltaScore100,
      deltaScore5: record.deltaScore5,
      status: record.status,
      errorMessage: record.errorMessage,
    }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
