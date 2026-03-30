import { mkdir, readFile, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import { join, resolve } from 'path';
import {
  buildPublicScaleBenchmarkSuiteConfig,
  buildPublicScalePipelineSuite,
  fetchPublicScaleSourceData,
  writePublicScalePipelineArtifacts,
} from '../src';

interface CliArgs {
  outputDir: string;
  callLimit: number;
  ticketLimit: number;
  emailLimit: number;
  reviewedDatasetPath: string;
  tenantPackPath: string;
  starterManifestPath: string;
  doc2dialManifestPath?: string;
  callcenterenManifestPath?: string;
  concurrency?: number;
  perRecordTimeoutMs?: number;
  childTimeoutMs?: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length < 1) {
    throw new Error('Usage: tsx examples/run-public-scale-benchmark.ts <output-dir> [--call-limit N] [--ticket-limit N] [--email-limit N] [--reviewed-dataset PATH] [--tenant-pack PATH] [--starter-manifest PATH] [--doc2dial-manifest PATH] [--callcenteren-manifest PATH] [--concurrency N] [--per-record-timeout-ms N] [--child-timeout-ms N] [--verbose]');
  }

  const args: CliArgs = {
    outputDir: argv[0],
    callLimit: 20,
    ticketLimit: 20,
    emailLimit: 20,
    reviewedDatasetPath: 'fixtures/sentiment-reviewed-outcomes.support.json',
    tenantPackPath: 'fixtures/tenant-pack.support.acme.json',
    starterManifestPath: 'fixtures/public-data/pipeline-suite.json',
    doc2dialManifestPath: 'fixtures/public-data/pipeline-suite.support-doc2dial.json',
    callcenterenManifestPath: 'fixtures/public-data/pipeline-suite.support-callcenteren.research.json',
    verbose: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--call-limit':
        args.callLimit = Number(argv[index + 1]);
        index += 1;
        break;
      case '--ticket-limit':
        args.ticketLimit = Number(argv[index + 1]);
        index += 1;
        break;
      case '--email-limit':
        args.emailLimit = Number(argv[index + 1]);
        index += 1;
        break;
      case '--reviewed-dataset':
        args.reviewedDatasetPath = argv[index + 1] ?? args.reviewedDatasetPath;
        index += 1;
        break;
      case '--tenant-pack':
        args.tenantPackPath = argv[index + 1] ?? args.tenantPackPath;
        index += 1;
        break;
      case '--starter-manifest':
        args.starterManifestPath = argv[index + 1] ?? args.starterManifestPath;
        index += 1;
        break;
      case '--doc2dial-manifest':
        args.doc2dialManifestPath = argv[index + 1];
        index += 1;
        break;
      case '--callcenteren-manifest':
        args.callcenterenManifestPath = argv[index + 1];
        index += 1;
        break;
      case '--concurrency':
        args.concurrency = Number(argv[index + 1]);
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
  const outputDir = resolve(process.cwd(), args.outputDir);
  const dataDir = join(outputDir, 'data');
  const rawDir = join(outputDir, 'raw');
  const loopDir = join(outputDir, 'loop');
  await mkdir(outputDir, { recursive: true });

  const sourceData = await fetchPublicScaleSourceData({
    cacheDir: rawDir,
  });
  const scaleSuite = buildPublicScalePipelineSuite({
    taskmasterDialogs: {
      self: sourceData.self,
      woz: sourceData.woz,
    },
    abcdDataset: sourceData.abcdDataset,
    callLimit: args.callLimit,
    ticketLimit: args.ticketLimit,
    emailLimit: args.emailLimit,
  });
  const scaleArtifacts = await writePublicScalePipelineArtifacts(dataDir, scaleSuite);
  const benchmarkSuite = buildPublicScaleBenchmarkSuiteConfig({
    scaleManifestPath: scaleArtifacts.manifestPath,
    tenantPackPath: resolve(process.cwd(), args.tenantPackPath),
    starterManifestPath: resolve(process.cwd(), args.starterManifestPath),
    doc2dialManifestPath: args.doc2dialManifestPath ? resolve(process.cwd(), args.doc2dialManifestPath) : undefined,
    callcenterenManifestPath: args.callcenterenManifestPath ? resolve(process.cwd(), args.callcenterenManifestPath) : undefined,
  });
  const benchmarkSuitePath = join(outputDir, 'e2e-public-scale-suite.json');
  await writeFile(benchmarkSuitePath, JSON.stringify(benchmarkSuite, null, 2));

  const loopArgs = [
    'examples/run-e2e-improvement-loop-isolated.ts',
    benchmarkSuitePath,
    loopDir,
    '--reviewed-dataset',
    resolve(process.cwd(), args.reviewedDatasetPath),
    '--calibration-source',
    'reviewed',
  ];
  if (typeof args.concurrency === 'number') {
    loopArgs.push('--concurrency', String(args.concurrency));
  }
  if (typeof args.perRecordTimeoutMs === 'number') {
    loopArgs.push('--per-record-timeout-ms', String(args.perRecordTimeoutMs));
  }
  if (typeof args.childTimeoutMs === 'number') {
    loopArgs.push('--child-timeout-ms', String(args.childTimeoutMs));
  }
  if (args.verbose) {
    loopArgs.push('--verbose');
  }

  const child = await runChild(loopArgs);
  if (child.exitCode !== 0) {
    throw new Error(extractFailureMessage(child.stderr || child.stdout));
  }

  const loopReportPath = join(loopDir, 'loop-report.json');
  const loopReport = JSON.parse(await readFile(loopReportPath, 'utf8'));
  const metadataPath = join(outputDir, 'public-scale-benchmark-run.json');
  await writeFile(metadataPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    outputDir,
    rawDir,
    benchmarkSuitePath,
    reviewedDatasetPath: resolve(process.cwd(), args.reviewedDatasetPath),
    scaleSummaryPath: scaleArtifacts.summaryPath,
    loopReportPath,
    parameters: {
      callLimit: args.callLimit,
      ticketLimit: args.ticketLimit,
      emailLimit: args.emailLimit,
      concurrency: args.concurrency ?? 1,
      perRecordTimeoutMs: args.perRecordTimeoutMs ?? null,
      childTimeoutMs: args.childTimeoutMs ?? null,
    },
    summary: loopReport.calibrated?.summary ?? loopReport.baseline.summary,
    gates: loopReport.calibrated?.gates ?? loopReport.baseline.gates,
  }, null, 2));

  console.log(JSON.stringify({
    outputDir,
    benchmarkSuitePath,
    scaleSummaryPath: scaleArtifacts.summaryPath,
    loopReportPath,
    metadataPath,
    summary: loopReport.calibrated?.summary ?? loopReport.baseline.summary,
    gates: loopReport.calibrated?.gates ?? loopReport.baseline.gates,
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
    return 'public scale benchmark failed without output';
  }
  return trimmed.split(/\r?\n/).filter(Boolean).at(-1) ?? trimmed;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
