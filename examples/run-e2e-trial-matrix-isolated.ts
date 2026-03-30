import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import {
  aggregateE2eTrialExecutions,
  e2eImprovementLoopReportSchema,
  e2eTrialExecutionSchema,
} from '../src';

interface CliArgs {
  suitePath: string;
  outputDir: string;
  trials: number;
  reviewedDatasetPath?: string;
  calibrationSource: 'auto' | 'reviewed' | 'benchmark';
  concurrency?: number;
  maxRecordsPerSource?: number;
  perRecordTimeoutMs?: number;
  childTimeoutMs?: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length < 2) {
    throw new Error('Usage: tsx examples/run-e2e-trial-matrix-isolated.ts <suite-path> <output-dir> [--trials N] [--reviewed-dataset PATH] [--calibration-source auto|reviewed|benchmark] [--concurrency N] [--max-records-per-source N] [--per-record-timeout-ms N] [--child-timeout-ms N] [--verbose]');
  }

  const input: CliArgs = {
    suitePath: argv[0],
    outputDir: argv[1],
    trials: 3,
    calibrationSource: 'auto',
    verbose: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--trials':
        input.trials = Number(argv[index + 1]);
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

  if (!Number.isInteger(input.trials) || input.trials <= 0) {
    throw new Error(`Invalid --trials value: ${input.trials}`);
  }

  return input;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = resolve(args.outputDir);
  await mkdir(outputDir, { recursive: true });
  const trialsDir = join(outputDir, 'trials');
  await mkdir(trialsDir, { recursive: true });
  const progressPath = join(outputDir, 'progress.jsonl');
  const executions = [];

  for (let index = 0; index < args.trials; index += 1) {
    const trialId = String(index + 1).padStart(3, '0');
    const trialDir = join(trialsDir, trialId);
    await mkdir(trialDir, { recursive: true });
    console.error(`[matrix] starting trial ${trialId}/${String(args.trials).padStart(3, '0')}`);

    const execution = await runTrial(trialId, trialDir, args);
    executions.push(execution);
    await appendFile(progressPath, `${JSON.stringify(execution)}\n`);
  }

  const summary = aggregateE2eTrialExecutions(executions);
  const executionsPath = join(outputDir, 'executions.json');
  const summaryPath = join(outputDir, 'summary.json');
  await writeFile(executionsPath, JSON.stringify(executions, null, 2));
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));

  console.log(JSON.stringify({
    outputDir,
    executionsPath,
    summaryPath,
    summary,
  }, null, 2));
}

async function runTrial(
  trialId: string,
  trialDir: string,
  args: CliArgs,
): Promise<ReturnType<typeof e2eTrialExecutionSchema.parse>> {
  const childArgs = [
    'examples/run-e2e-improvement-loop-isolated.ts',
    resolve(args.suitePath),
    trialDir,
    '--calibration-source',
    args.calibrationSource,
    '--concurrency',
    String(args.concurrency ?? 1),
  ];
  if (args.reviewedDatasetPath) {
    childArgs.push('--reviewed-dataset', resolve(args.reviewedDatasetPath));
  }
  if (typeof args.maxRecordsPerSource === 'number') {
    childArgs.push('--max-records-per-source', String(args.maxRecordsPerSource));
  }
  if (typeof args.perRecordTimeoutMs === 'number') {
    childArgs.push('--per-record-timeout-ms', String(args.perRecordTimeoutMs));
  }
  if (typeof args.childTimeoutMs === 'number') {
    childArgs.push('--child-timeout-ms', String(args.childTimeoutMs));
  }
  if (args.verbose) {
    childArgs.push('--verbose');
  }

  const result = await runChild(childArgs);
  if (result.exitCode !== 0) {
    return e2eTrialExecutionSchema.parse({
      trialId,
      status: 'FAILED',
      outputDir: trialDir,
      errorMessage: extractFailureMessage(result.stderr || result.stdout),
    });
  }

  const reportPath = join(trialDir, 'loop-report.json');
  const report = e2eImprovementLoopReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));
  return e2eTrialExecutionSchema.parse({
    trialId,
    status: 'COMPLETED',
    outputDir: trialDir,
    reportPath,
    report,
  });
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

function parseCalibrationSource(input: string | undefined): CliArgs['calibrationSource'] {
  if (input === 'auto' || input === 'reviewed' || input === 'benchmark') {
    return input;
  }
  throw new Error(`Unknown calibration source: ${input}`);
}

function extractFailureMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return 'trial failed without output';
  }
  return trimmed.split(/\r?\n/).filter(Boolean).at(-1) ?? trimmed;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
