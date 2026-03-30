import { mkdir, readFile, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import { join, resolve } from 'path';
import {
  buildReviewedBenchmarkDataset,
  writeReviewedBenchmarkDataset,
} from '../src';

interface CliArgs {
  outputDir: string;
  manifests: string[];
  annotationManifests: string[];
  tenantPackPath: string;
  packVersion?: string;
  promptVersion?: string;
  classification: 'INTERNAL' | 'RESTRICTED';
  calibrationSource: 'auto' | 'reviewed' | 'benchmark';
  mode: 'isolated' | 'in_process';
  concurrency?: number;
  maxRecordsPerSource?: number;
  perRecordTimeoutMs?: number;
  childTimeoutMs?: number;
  verbose: boolean;
}

const defaultManifestPaths = [
  'fixtures/public-data/pipeline-suite.json',
  'fixtures/public-data/pipeline-suite.support-doc2dial.json',
  'fixtures/public-data/pipeline-suite.support-callcenteren.research.json',
];

function parseArgs(argv: string[]): CliArgs {
  if (argv.length < 1) {
    throw new Error('Usage: tsx examples/run-public-reviewed-benchmark.ts <output-dir> [--manifest PATH]... [--annotation-manifest PATH]... [--tenant-pack PATH] [--pack-version VERSION] [--prompt-version VERSION] [--classification INTERNAL|RESTRICTED] [--calibration-source auto|reviewed|benchmark] [--mode isolated|in_process] [--concurrency N] [--max-records-per-source N] [--per-record-timeout-ms N] [--child-timeout-ms N] [--verbose]');
  }

  const args: CliArgs = {
    outputDir: argv[0],
    manifests: [],
    annotationManifests: [],
    tenantPackPath: 'fixtures/tenant-pack.support.acme.json',
    classification: 'INTERNAL',
    calibrationSource: 'reviewed',
    mode: 'isolated',
    verbose: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--manifest':
        args.manifests.push(argv[index + 1] ?? '');
        index += 1;
        break;
      case '--annotation-manifest':
        args.annotationManifests.push(argv[index + 1] ?? '');
        index += 1;
        break;
      case '--tenant-pack':
        args.tenantPackPath = argv[index + 1] ?? args.tenantPackPath;
        index += 1;
        break;
      case '--pack-version':
        args.packVersion = argv[index + 1];
        index += 1;
        break;
      case '--prompt-version':
        args.promptVersion = argv[index + 1];
        index += 1;
        break;
      case '--classification': {
        const value = (argv[index + 1] ?? '').toUpperCase();
        if (value !== 'INTERNAL' && value !== 'RESTRICTED') {
          throw new Error(`Invalid classification: ${argv[index + 1]}`);
        }
        args.classification = value;
        index += 1;
        break;
      }
      case '--calibration-source': {
        const value = argv[index + 1];
        if (value !== 'auto' && value !== 'reviewed' && value !== 'benchmark') {
          throw new Error(`Invalid calibration source: ${value}`);
        }
        args.calibrationSource = value;
        index += 1;
        break;
      }
      case '--mode': {
        const value = argv[index + 1];
        if (value !== 'isolated' && value !== 'in_process') {
          throw new Error(`Invalid mode: ${value}`);
        }
        args.mode = value;
        index += 1;
        break;
      }
      case '--concurrency':
        args.concurrency = Number(argv[index + 1]);
        index += 1;
        break;
      case '--max-records-per-source':
        args.maxRecordsPerSource = Number(argv[index + 1]);
        index += 1;
        break;
      case '--per-record-timeout-ms':
        args.perRecordTimeoutMs = Number(argv[index + 1]);
        index += 1;
        break;
      case '--child-timeout-ms':
        args.childTimeoutMs = Number(argv[index + 1]);
        index += 1;
        break;
      case '--verbose':
        args.verbose = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = resolve(args.outputDir);
  const datasetOutputDir = join(outputDir, 'reviewed-benchmark-dataset');
  const loopOutputDir = join(outputDir, 'loop');
  const inputPaths = dedupePaths([
    ...(args.manifests.length > 0 ? args.manifests : defaultManifestPaths),
    ...args.annotationManifests,
  ]).map((path) => resolve(path));
  const inputs = await Promise.all(inputPaths.map(async (path) => ({
    path,
    content: JSON.parse(await readFile(path, 'utf8')),
  })));

  const dataset = buildReviewedBenchmarkDataset(inputs, {
    packVersion: args.packVersion,
    promptVersion: args.promptVersion,
    classification: args.classification,
  });
  const datasetArtifacts = await writeReviewedBenchmarkDataset(datasetOutputDir, dataset);
  const suitePath = join(outputDir, 'reviewed-benchmark-suite.json');

  await mkdir(loopOutputDir, { recursive: true });
  await writeFile(suitePath, JSON.stringify({
    sources: datasetArtifacts.scopeArtifacts.map((scope) => ({
      sourceId: `reviewed-${scope.tenantId}-${scope.useCase}`,
      kind: 'reviewed_run_exports',
      path: join(datasetOutputDir, scope.tenantId, scope.useCase),
      tenantPackPath: resolve(args.tenantPackPath),
      requireAnalystSentiment: true,
    })),
  }, null, 2));

  const childArgs = [
    args.mode === 'isolated'
      ? 'examples/run-e2e-improvement-loop-isolated.ts'
      : 'examples/run-e2e-improvement-loop.ts',
    suitePath,
    loopOutputDir,
    '--calibration-source',
    args.calibrationSource,
  ];
  if (args.calibrationSource !== 'benchmark') {
    childArgs.push('--reviewed-dataset', datasetOutputDir);
  }
  if (typeof args.concurrency === 'number') {
    childArgs.push('--concurrency', String(args.concurrency));
  }
  if (typeof args.maxRecordsPerSource === 'number') {
    childArgs.push('--max-records-per-source', String(args.maxRecordsPerSource));
  }
  if (typeof args.perRecordTimeoutMs === 'number') {
    childArgs.push('--per-record-timeout-ms', String(args.perRecordTimeoutMs));
  }
  if (typeof args.childTimeoutMs === 'number' && args.mode === 'isolated') {
    childArgs.push('--child-timeout-ms', String(args.childTimeoutMs));
  }
  if (args.verbose) {
    childArgs.push('--verbose');
  }

  const result = await runChild(childArgs);
  if (result.exitCode !== 0) {
    throw new Error(extractFailureMessage(result.stderr || result.stdout));
  }

  const loopReportPath = join(loopOutputDir, 'loop-report.json');
  const metadataPath = join(outputDir, 'public-reviewed-benchmark-run.json');
  const loopReport = JSON.parse(await readFile(loopReportPath, 'utf8'));
  const selectedVariant = selectPreferredVariant(loopReport);

  await writeFile(metadataPath, JSON.stringify({
    outputDir,
    inputPaths,
    datasetOutputDir,
    datasetSummaryPath: datasetArtifacts.summaryPath,
    annotationBatchPath: datasetArtifacts.annotationBatchPath,
    suitePath,
    scopeArtifacts: datasetArtifacts.scopeArtifacts,
    loopReportPath,
    selectedVariant,
    summary: loopReport[selectedVariant].summary,
  }, null, 2));

  console.log(JSON.stringify({
    outputDir,
    datasetOutputDir,
    datasetSummaryPath: datasetArtifacts.summaryPath,
    annotationBatchPath: datasetArtifacts.annotationBatchPath,
    suitePath,
    scopeArtifacts: datasetArtifacts.scopeArtifacts,
    loopReportPath,
    metadataPath,
    selectedVariant,
    summary: loopReport[selectedVariant].summary,
  }, null, 2));
}

function selectPreferredVariant(loopReport: {
  baseline: {
    summary: {
      overall: {
        averageDeltaScore100?: number;
        withinFivePointsRate?: number;
        exactScore5MatchRate?: number;
      };
    };
    gates: {
      metExpectations: boolean;
    };
  };
  calibrated?: {
    summary: {
      overall: {
        averageDeltaScore100?: number;
        withinFivePointsRate?: number;
        exactScore5MatchRate?: number;
      };
    };
    gates: {
      metExpectations: boolean;
    };
  } | null;
}): 'baseline' | 'calibrated' {
  if (!loopReport.calibrated) {
    return 'baseline';
  }
  if (loopReport.baseline.gates.metExpectations && !loopReport.calibrated.gates.metExpectations) {
    return 'baseline';
  }
  if (!loopReport.baseline.gates.metExpectations && loopReport.calibrated.gates.metExpectations) {
    return 'calibrated';
  }

  const baselineOverall = loopReport.baseline.summary.overall;
  const calibratedOverall = loopReport.calibrated.summary.overall;
  const baselineWithinFive = baselineOverall.withinFivePointsRate ?? 0;
  const calibratedWithinFive = calibratedOverall.withinFivePointsRate ?? 0;
  if (baselineWithinFive !== calibratedWithinFive) {
    return baselineWithinFive > calibratedWithinFive ? 'baseline' : 'calibrated';
  }

  const baselineDelta = baselineOverall.averageDeltaScore100 ?? Number.POSITIVE_INFINITY;
  const calibratedDelta = calibratedOverall.averageDeltaScore100 ?? Number.POSITIVE_INFINITY;
  if (baselineDelta !== calibratedDelta) {
    return baselineDelta < calibratedDelta ? 'baseline' : 'calibrated';
  }

  const baselineExact = baselineOverall.exactScore5MatchRate ?? 0;
  const calibratedExact = calibratedOverall.exactScore5MatchRate ?? 0;
  if (baselineExact !== calibratedExact) {
    return baselineExact > calibratedExact ? 'baseline' : 'calibrated';
  }

  return 'baseline';
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
    return 'public reviewed benchmark loop failed without output';
  }
  return trimmed.split(/\r?\n/).filter(Boolean).at(-1) ?? trimmed;
}

function dedupePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter((path) => path.length > 0)));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
