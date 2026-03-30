import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  AnalysisWorker,
  ConversationIntelligenceService,
  RlmCanonicalAnalysisEngine,
  SqliteJobStore,
  TenantPackDraft,
  TranscriptInputDraft,
  resolveProviderProfileFromEnv,
} from '../src';

function loadJson<T>(relativePath: string): T {
  const absolutePath = resolve(__dirname, '..', relativePath);
  return JSON.parse(readFileSync(absolutePath, 'utf8')) as T;
}

async function main(): Promise<void> {
  const store = new SqliteJobStore(resolve(process.cwd(), 'data', 'embedded-runtime.sqlite'));
  await store.initialize();

  const service = new ConversationIntelligenceService({
    store,
    engine: new RlmCanonicalAnalysisEngine(resolveProviderProfileFromEnv(process.env)),
  });
  const worker = new AnalysisWorker({
    service,
    pollIntervalMs: 50,
    workerId: 'embedded-example-worker',
  });

  worker.start();

  const queued = await service.submitJob({
    transcript: loadJson<TranscriptInputDraft>('fixtures/transcript.support.basic.json'),
    tenantPack: loadJson<TenantPackDraft>('fixtures/tenant-pack.support.acme.json'),
  });

  while (true) {
    const latest = await service.getJob(queued.jobId);
    if (latest?.status === 'COMPLETED') {
      console.log(JSON.stringify({
        jobId: latest.jobId,
        status: latest.status,
        summary: latest.result?.summary,
        review: latest.result?.review,
      }, null, 2));
      break;
    }

    if (latest?.status === 'FAILED') {
      throw new Error(latest.error?.message ?? 'Embedded run failed.');
    }

    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }

  await worker.stop();
  await store.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
