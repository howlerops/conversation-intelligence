import { appendFile, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import {
  buildE2eBenchmarkSummary,
  E2eBenchmarkRecordResult,
  e2eBenchmarkRecordResultSchema,
  e2eBenchmarkReportSchema,
  listE2eBenchmarkTargets,
  loadE2eBenchmarkSuiteFromPath,
  writeE2eBenchmarkArtifacts,
} from '../src';

interface CliArgs {
  suitePath: string;
  outputDir: string;
  concurrency?: number;
  maxRecordsPerSource?: number;
  calibrationConfigPath?: string;
  perRecordTimeoutMs?: number;
  childTimeoutMs?: number;
  progressLogPath?: string;
  verbose: boolean;
}

interface ChildResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length < 2) {
    throw new Error('Usage: tsx examples/run-e2e-benchmark-isolated.ts <suite-path> <output-dir> [--concurrency N] [--max-records-per-source N] [--calibration-config PATH] [--per-record-timeout-ms N] [--child-timeout-ms N] [--progress-log PATH] [--verbose]');
  }

  const input: CliArgs = {
    suitePath: argv[0],
    outputDir: argv[1],
    verbose: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--concurrency':
        input.concurrency = Number(argv[index + 1]);
        index += 1;
        break;
      case '--max-records-per-source':
        input.maxRecordsPerSource = Number(argv[index + 1]);
        index += 1;
        break;
      case '--calibration-config':
        input.calibrationConfigPath = argv[index + 1];
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
  const targets = await listE2eBenchmarkTargets(suite, args.maxRecordsPerSource);
  const outputDir = resolve(args.outputDir);
  await mkdir(outputDir, { recursive: true });
  const progressLogPath = resolve(args.progressLogPath ?? join(outputDir, 'progress.jsonl'));
  const childTimeoutMs = args.childTimeoutMs
    ?? (typeof args.perRecordTimeoutMs === 'number' ? args.perRecordTimeoutMs + 10000 : undefined);
  const results = new Array<E2eBenchmarkRecordResult>(targets.length);
  const childArtifactsDir = join(outputDir, '_children');
  await rm(childArtifactsDir, { recursive: true, force: true });
  await mkdir(childArtifactsDir, { recursive: true });
  const startedAt = Date.now();

  await mapWithConcurrency(targets, Math.max(1, args.concurrency ?? 1), async (target, index) => {
      const targetDir = join(childArtifactsDir, `${String(index + 1).padStart(4, '0')}-${sanitizeForPath(target.recordId)}`);
      await mkdir(targetDir, { recursive: true });
      const targetSuitePath = join(targetDir, 'suite.json');
      const targetOutputDir = join(targetDir, 'output');

      const targetSource = target.kind === 'public_pipeline_suite'
        ? {
          ...target.source,
          pipelineIds: target.pipelineId ? [target.pipelineId] : undefined,
          recordIds: [target.recordId],
          engagementTypes: target.engagementType === 'UNSPECIFIED' ? target.source.engagementTypes : [target.engagementType],
        }
        : {
          ...target.source,
          recordIds: [target.recordId],
          engagementTypes: target.engagementType === 'UNSPECIFIED' ? target.source.engagementTypes : [target.engagementType],
        };

      await writeFile(targetSuitePath, JSON.stringify({ sources: [targetSource] }, null, 2));
      await appendFile(progressLogPath, `${JSON.stringify({
        type: 'record_start',
        at: new Date().toISOString(),
        index: target.index + 1,
        total: target.total,
        sourceId: target.sourceId,
        recordId: target.recordId,
        pipelineId: target.pipelineId ?? null,
        engagementType: target.engagementType,
        queue: target.queue ?? null,
      })}\n`);
      console.error(`[isolated] [${target.index + 1}/${target.total}] start ${target.engagementType} ${target.recordId}`);

      const childArgs = [
        'examples/run-e2e-benchmark.ts',
        targetSuitePath,
        targetOutputDir,
        '--concurrency',
        '1',
      ];
      if (typeof args.perRecordTimeoutMs === 'number') {
        childArgs.push('--per-record-timeout-ms', String(args.perRecordTimeoutMs));
      }
      if (args.calibrationConfigPath) {
        childArgs.push('--calibration-config', resolve(args.calibrationConfigPath));
      }
      if (args.verbose) {
        childArgs.push('--verbose');
      }

      const child = await runChildBenchmark(childArgs, childTimeoutMs);
      await writeFile(join(targetDir, 'stdout.log'), child.stdout);
      await writeFile(join(targetDir, 'stderr.log'), child.stderr);

      let result: E2eBenchmarkRecordResult;
      if (child.exitCode === 0) {
        result = await loadSingleRecordResult(targetOutputDir, target, child);
      } else {
        result = e2eBenchmarkRecordResultSchema.parse({
          sourceId: target.sourceId,
          recordId: target.recordId,
          tenantId: target.tenantId,
          useCase: target.useCase,
          engagementType: target.engagementType,
          queue: target.queue,
          transcriptLengthBucket: target.transcriptLengthBucket,
          transcriptTurnCount: target.transcriptTurnCount,
          transcriptCharacterCount: target.transcriptCharacterCount,
          status: 'FAILED',
          durationMs: childTimeoutMs ?? 0,
          reviewReasons: [],
          packVersion: target.packVersion,
          sentiment: null,
          errorMessage: child.timedOut
            ? `Child benchmark timed out after ${childTimeoutMs}ms`
            : extractFailureMessage(child.stderr || child.stdout || `Child exited with code ${child.exitCode}`),
        });
      }

      results[index] = result;
      await appendFile(progressLogPath, `${JSON.stringify({
        type: 'record_complete',
        at: new Date().toISOString(),
        index: target.index + 1,
        total: target.total,
        sourceId: target.sourceId,
        recordId: target.recordId,
        status: result.status,
        durationMs: result.durationMs,
        reviewState: result.reviewState ?? null,
        deltaScore100: result.deltaScore100 ?? null,
        deltaScore5: result.deltaScore5 ?? null,
        errorMessage: result.errorMessage ?? null,
      })}\n`);
      const suffix = result.errorMessage ? ` error=${result.errorMessage}` : '';
      console.error(`[isolated] [${target.index + 1}/${target.total}] done ${target.recordId} status=${result.status} durationMs=${result.durationMs}${suffix}`);
    });

  const report = e2eBenchmarkReportSchema.parse({
    generatedAt: new Date().toISOString(),
    summary: buildE2eBenchmarkSummary(results),
    records: results,
  });
  const artifacts = await writeE2eBenchmarkArtifacts(outputDir, report);
  const metadataPath = join(outputDir, 'metadata.json');
  await writeFile(metadataPath, JSON.stringify({
    suitePath: resolve(args.suitePath),
    outputDir,
    progressLogPath,
    calibrationConfigPath: args.calibrationConfigPath ? resolve(args.calibrationConfigPath) : null,
    perRecordTimeoutMs: args.perRecordTimeoutMs ?? null,
    childTimeoutMs: childTimeoutMs ?? null,
    durationMs: Date.now() - startedAt,
    summaryPath: artifacts.summaryPath,
    recordsPath: artifacts.recordsPath,
    childArtifactsDir,
  }, null, 2));

  console.log(JSON.stringify({
    outputDir,
    metadataPath,
    progressLogPath,
    summary: report.summary,
  }, null, 2));
}

async function runChildBenchmark(args: string[], timeoutMs: number | undefined): Promise<ChildResult> {
  const child = spawn('./node_modules/.bin/tsx', args, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
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

  let timedOut = false;
  const timeoutHandle = typeof timeoutMs === 'number' && timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
      }, 1000).unref();
    }, timeoutMs)
    : undefined;

  const exitCode = await new Promise<number | null>((resolveChild) => {
    child.on('exit', (code) => resolveChild(code));
    child.on('error', () => resolveChild(1));
  });

  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  return {
    exitCode,
    timedOut,
    stdout,
    stderr,
  };
}

async function loadSingleRecordResult(
  outputDir: string,
  target: Awaited<ReturnType<typeof listE2eBenchmarkTargets>>[number],
  child: ChildResult,
): Promise<E2eBenchmarkRecordResult> {
  const recordsPath = join(outputDir, 'records.jsonl');
  const raw = (await readFile(recordsPath, 'utf8')).trim();
  if (!raw) {
    throw new Error(`Child benchmark produced no records for ${target.recordId}`);
  }

  const records = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => e2eBenchmarkRecordResultSchema.parse(JSON.parse(line)));

  if (records.length !== 1) {
    throw new Error(`Expected exactly one child record for ${target.recordId}; received ${records.length}`);
  }

  return records[0]!;
}

function extractFailureMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return 'Child benchmark failed without output.';
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  return lines.at(-1) ?? trimmed;
}

function sanitizeForPath(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const current = cursor;
      cursor += 1;
      await worker(values[current]!, current);
    }
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
