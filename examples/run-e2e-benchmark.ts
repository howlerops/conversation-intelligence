import { appendFile, mkdir, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import {
  loadE2eBenchmarkSuiteFromPath,
  resolveProviderProfileFromEnv,
  RlmCanonicalAnalysisEngine,
  runE2eBenchmarkSuite,
  writeE2eBenchmarkArtifacts,
} from '../src';

interface CliArgs {
  suitePath: string;
  outputDir: string;
  concurrency?: number;
  maxRecordsPerSource?: number;
  calibrationConfigPath?: string;
  perRecordTimeoutMs?: number;
  progressLogPath?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length < 2) {
    throw new Error('Usage: tsx examples/run-e2e-benchmark.ts <suite-path> <output-dir> [--concurrency N] [--max-records-per-source N] [--calibration-config PATH] [--per-record-timeout-ms N] [--progress-log PATH] [--verbose]');
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

  const benchmarkStartedAt = Date.now();
  const report = await runE2eBenchmarkSuite(suite, {
    engine,
    concurrency: args.concurrency,
    maxRecordsPerSource: args.maxRecordsPerSource,
    calibrationConfigPath: args.calibrationConfigPath ? resolve(args.calibrationConfigPath) : undefined,
    perRecordTimeoutMs: args.perRecordTimeoutMs,
    onRecordStart: async (update) => {
      const payload = {
        type: 'record_start',
        at: new Date().toISOString(),
        index: update.index + 1,
        total: update.total,
        sourceId: update.sourceId,
        recordId: update.recordId,
        pipelineId: update.pipelineId ?? null,
        engagementType: update.engagementType,
        queue: update.queue ?? null,
      };
      await appendFile(progressLogPath, `${JSON.stringify(payload)}\n`);
      console.error(`[${payload.index}/${payload.total}] start ${payload.engagementType} ${payload.recordId}`);
    },
    onRecordComplete: async (update) => {
      const payload = {
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
      };
      await appendFile(progressLogPath, `${JSON.stringify(payload)}\n`);
      const suffix = payload.errorMessage ? ` error=${payload.errorMessage}` : '';
      console.error(`[${payload.index}/${payload.total}] done ${payload.recordId} status=${payload.status} durationMs=${payload.durationMs}${suffix}`);
    },
  });

  const artifacts = await writeE2eBenchmarkArtifacts(outputDir, report);
  const metadataPath = join(outputDir, 'metadata.json');
  await writeFile(metadataPath, JSON.stringify({
    suitePath: resolve(args.suitePath),
    outputDir,
    calibrationConfigPath: args.calibrationConfigPath ? resolve(args.calibrationConfigPath) : null,
    perRecordTimeoutMs: args.perRecordTimeoutMs ?? null,
    progressLogPath,
    providerProfile: {
      provider: providerProfile.provider,
      model: providerProfile.model,
      apiBase: providerProfile.apiBase ?? null,
    },
    summaryPath: artifacts.summaryPath,
    recordsPath: artifacts.recordsPath,
    durationMs: Date.now() - benchmarkStartedAt,
  }, null, 2));

  console.log(JSON.stringify({
    outputDir,
    metadataPath,
    progressLogPath,
    summary: report.summary,
  }, null, 2));
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
