import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  analyzeConversation,
  RlmCanonicalAnalysisEngine,
  TranscriptInputDraft,
  TenantPackDraft,
} from '../src';

function loadJson<T>(relativePath: string): T {
  const absolutePath = resolve(__dirname, '..', relativePath);
  return JSON.parse(readFileSync(absolutePath, 'utf8')) as T;
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY must be set to run the fixture analyzer.');
  }

  const transcript = loadJson<TranscriptInputDraft>('fixtures/transcript.support.basic.json');
  const tenantPack = loadJson<TenantPackDraft>('fixtures/tenant-pack.support.acme.json');

  const engine = new RlmCanonicalAnalysisEngine({
    model: process.env.CI_RLM_MODEL ?? 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
    apiBase: process.env.OPENAI_API_BASE,
    goBinaryPath: process.env.RLM_GO_BINARY,
    maxDepth: 2,
    maxIterations: 10,
  });

  const result = await analyzeConversation(transcript, tenantPack, {
    engine,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
