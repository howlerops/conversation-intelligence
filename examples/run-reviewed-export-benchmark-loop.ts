import { mkdir, readFile, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import { join, resolve } from 'path';
import {
  summarizeReviewedExportDataset,
} from '../src';

interface CliArgs {
  reviewedDataPath: string;
  tenantPackPath: string;
  outputDir: string;
  sourceId: string;
  reviewedDatasetPath?: string;
  calibrationSource: 'auto' | 'reviewed' | 'benchmark';
  mode: 'isolated' | 'in_process';
  requireAnalystSentiment: boolean;
  concurrency?: number;
  maxRecordsPerSource?: number;
  perRecordTimeoutMs?: number;
  childTimeoutMs?: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length < 3) {
    throw new Error('Usage: tsx examples/run-reviewed-export-benchmark-loop.ts <reviewed-data-path> <tenant-pack-path> <output-dir> [--source-id ID] [--reviewed-dataset PATH] [--calibration-source auto|reviewed|benchmark] [--mode isolated|in_process] [--require-analyst-sentiment true|false] [--concurrency N] [--max-records-per-source N] [--per-record-timeout-ms N] [--child-timeout-ms N] [--verbose]');
  }

  const input: CliArgs = {
    reviewedDataPath: argv[0],
    tenantPackPath: argv[1],
    outputDir: argv[2],
    sourceId: 'reviewed-export-tree',
    calibrationSource: 'auto',
    mode: 'isolated',
    requireAnalystSentiment: true,
    verbose: false,
  };

  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--source-id':
        input.sourceId = argv[index + 1] ?? input.sourceId;
        index += 1;
        break;
      case '--reviewed-dataset':
        input.reviewedDatasetPath = argv[index + 1];
        index += 1;
        break;
      case '--calibration-source':
        input.calibrationSource = parseCalibrationSource(argv[index + 1]);
        index += 1;
        break;
      case '--mode':
        input.mode = parseMode(argv[index + 1]);
        index += 1;
        break;
      case '--require-analyst-sentiment':
        input.requireAnalystSentiment = parseBoolean(argv[index + 1], true);
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
  const reviewedDataPath = resolve(args.reviewedDataPath);
  const tenantPackPath = resolve(args.tenantPackPath);
  const outputDir = resolve(args.outputDir);
  await mkdir(outputDir, { recursive: true });

  const datasetSummary = await summarizeReviewedExportDataset(reviewedDataPath, {
    requireAnalystSentiment: args.requireAnalystSentiment,
  });
  if (datasetSummary.recordCount === 0) {
    throw new Error('No reviewed export records matched the requested path and filters.');
  }
  if (datasetSummary.transcriptRecordCount === 0) {
    throw new Error('Reviewed export benchmark loop requires transcripts; this dataset has none.');
  }

  const datasetSummaryPath = join(outputDir, 'reviewed-dataset-summary.json');
  await writeFile(datasetSummaryPath, JSON.stringify(datasetSummary, null, 2));

  const suitePath = join(outputDir, 'reviewed-export-suite.json');
  await writeFile(suitePath, JSON.stringify({
    sources: [
      {
        sourceId: args.sourceId,
        kind: 'reviewed_run_exports',
        path: reviewedDataPath,
        tenantPackPath,
        requireAnalystSentiment: args.requireAnalystSentiment,
      },
    ],
  }, null, 2));

  const reviewedDatasetPath = args.reviewedDatasetPath
    ? resolve(args.reviewedDatasetPath)
    : reviewedDataPath;
  const childArgs = [
    args.mode === 'isolated'
      ? 'examples/run-e2e-improvement-loop-isolated.ts'
      : 'examples/run-e2e-improvement-loop.ts',
    suitePath,
    outputDir,
    '--calibration-source',
    args.calibrationSource,
  ];
  if (args.calibrationSource !== 'benchmark') {
    childArgs.push('--reviewed-dataset', reviewedDatasetPath);
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

  const { exitCode, stdout, stderr } = await runChild(childArgs);
  if (exitCode !== 0) {
    throw new Error(extractFailureMessage(stderr || stdout));
  }

  const loopReportPath = join(outputDir, 'loop-report.json');
  const loopReport = JSON.parse(await readFile(loopReportPath, 'utf8'));
  const metadataPath = join(outputDir, 'reviewed-export-benchmark-loop.json');
  await writeFile(metadataPath, JSON.stringify({
    reviewedDataPath,
    reviewedDatasetPath,
    tenantPackPath,
    outputDir,
    datasetSummaryPath,
    suitePath,
    loopReportPath,
    calibrationSource: args.calibrationSource,
    mode: args.mode,
  }, null, 2));

  console.log(JSON.stringify({
    outputDir,
    datasetSummaryPath,
    suitePath,
    loopReportPath,
    metadataPath,
    summary: loopReport.calibrated?.summary ?? loopReport.baseline.summary,
  }, null, 2));
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
    return 'reviewed export benchmark loop failed without output';
  }
  return trimmed.split(/\r?\n/).filter(Boolean).at(-1) ?? trimmed;
}

function parseCalibrationSource(value: string | undefined): CliArgs['calibrationSource'] {
  if (value === 'auto' || value === 'reviewed' || value === 'benchmark') {
    return value;
  }
  throw new Error(`Invalid calibration source: ${value}`);
}

function parseMode(value: string | undefined): CliArgs['mode'] {
  if (value === 'isolated' || value === 'in_process') {
    return value;
  }
  throw new Error(`Invalid mode: ${value}`);
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
