import { resolve } from 'path';
import {
  AnalysisWorker,
  ConversationIntelligenceService,
  RlmCanonicalAnalysisEngine,
  SqliteJobStore,
  startConversationIntelligenceServer,
} from '../src';

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY must be set before starting the server.');
  }

  const store = new SqliteJobStore(resolve(process.cwd(), 'data', 'conversation-intelligence.sqlite'));
  await store.initialize();

  const service = new ConversationIntelligenceService({
    store,
    engine: new RlmCanonicalAnalysisEngine({
      model: process.env.CI_RLM_MODEL ?? 'gpt-4o-mini',
      apiKey: process.env.OPENAI_API_KEY,
      apiBase: process.env.OPENAI_API_BASE,
      goBinaryPath: process.env.RLM_GO_BINARY,
      maxDepth: 2,
      maxIterations: 10,
      temperature: 0,
    }),
  });
  const worker = new AnalysisWorker({
    service,
    pollIntervalMs: 50,
  });
  worker.start();

  const port = Number(process.env.PORT ?? 8787);
  await startConversationIntelligenceServer(service, port);

  console.log(`conversation-intelligence listening on http://localhost:${port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
